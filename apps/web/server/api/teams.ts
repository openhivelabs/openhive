import { extractJson, loadSkillBody, rid, slugify } from '@/lib/server/ai-generators/common'
import { resolveTeamSlugs, saveTeam } from '@/lib/server/companies'
import { loadDashboard, saveDashboard } from '@/lib/server/dashboards'
import { FilesError, listFiles, readFile } from '@/lib/server/files'
import {
  type MessageRecord,
  clearTeam,
  listForTeam,
  nowTs,
  saveMessage,
} from '@/lib/server/messages'
import { chatCompletion } from '@/lib/server/providers/copilot'
import {
  createSnapshot,
  discardSnapshot,
  hasSnapshot,
  restoreSnapshot,
} from '@/lib/server/snapshots'
import { describeSchema, installTemplate, runExec, runQuery } from '@/lib/server/team-data'
import { Hono } from 'hono'

export const teams = new Hono()

const META_SYSTEM_PROMPT = loadSkillBody('design-team')

// ---------- POST /api/teams/generate ----------

interface GenerateBody {
  description?: string
  company_slug?: string
}

interface AgentLike {
  role?: unknown
  system_prompt?: unknown
}

interface EdgeLike {
  from?: unknown
  to?: unknown
}

function layoutPositions(nMembers: number): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [{ x: 400, y: 40 }]
  if (nMembers === 0) return positions
  const spacing = 260
  const totalWidth = nMembers > 1 ? spacing * (nMembers - 1) : 0
  const startX = 400 - totalWidth / 2
  for (let i = 0; i < nMembers; i += 1) {
    positions.push({ x: startX + i * spacing, y: 240 })
  }
  return positions
}

// LLM output caps. A design-time generator should never produce more than
// a handful of agents; anything larger is almost certainly the model
// hallucinating a whole department, which we refuse to commit to disk.
const MAX_AGENTS = 20
const MAX_EDGES = 100
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function detectCycle(edges: { source: string; target: string }[]): boolean {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    const list = adj.get(e.source) ?? []
    list.push(e.target)
    adj.set(e.source, list)
  }
  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const nodes = new Set<string>()
  for (const e of edges) {
    nodes.add(e.source)
    nodes.add(e.target)
  }
  for (const n of nodes) color.set(n, WHITE)
  const visit = (n: string): boolean => {
    color.set(n, GREY)
    for (const m of adj.get(n) ?? []) {
      const c = color.get(m) ?? WHITE
      if (c === GREY) return true
      if (c === WHITE && visit(m)) return true
    }
    color.set(n, BLACK)
    return false
  }
  for (const n of nodes) {
    if ((color.get(n) ?? WHITE) === WHITE && visit(n)) return true
  }
  return false
}

function buildTeamYaml(
  meta: Record<string, unknown>,
  description: string,
): Record<string, unknown> {
  const name =
    typeof meta.name === 'string' && meta.name ? meta.name : description.slice(0, 40) || 'New team'
  const agentsRaw = Array.isArray(meta.agents) ? (meta.agents as AgentLike[]) : []
  const edgesRaw = Array.isArray(meta.edges) ? (meta.edges as EdgeLike[]) : []
  if (agentsRaw.length === 0) throw new Error('meta-agent returned no agents')
  if (agentsRaw.length > MAX_AGENTS) {
    throw new Error(`meta-agent returned ${agentsRaw.length} agents (max ${MAX_AGENTS})`)
  }
  if (edgesRaw.length > MAX_EDGES) {
    throw new Error(`meta-agent returned ${edgesRaw.length} edges (max ${MAX_EDGES})`)
  }

  const roleToId = new Map<string, string>()
  const agents: Record<string, unknown>[] = []
  let leadCount = 0
  for (const a of agentsRaw) {
    const role = String(a.role ?? '').trim() || 'Member'
    if (role === 'Lead') leadCount += 1
    const aid = rid('a')
    roleToId.set(role, aid)
    agents.push({
      id: aid,
      role,
      label: 'Copilot',
      provider_id: 'copilot',
      model: 'gpt-5-mini',
      system_prompt:
        typeof a.system_prompt === 'string' && a.system_prompt
          ? a.system_prompt
          : `You are a ${role}.`,
      skills: [],
      position: { x: 0, y: 0 },
    })
  }
  if (leadCount !== 1) {
    throw new Error(`meta-agent returned ${leadCount} Leads (expected 1)`)
  }

  const lead = agents.find((a) => a.role === 'Lead')!
  const members = agents.filter((a) => a !== lead)
  const ordered = [lead, ...members]
  const positions = layoutPositions(members.length)
  ordered.forEach((a, i) => {
    a.position = positions[i]!
  })

  const edges: Record<string, unknown>[] = []
  for (const e of edgesRaw) {
    const src = roleToId.get(String(e.from ?? '').trim())
    const tgt = roleToId.get(String(e.to ?? '').trim())
    if (!src || !tgt || src === tgt) continue
    edges.push({ id: rid('e'), source: src, target: tgt })
  }
  if (edges.length === 0) {
    const leadId = lead.id as string
    for (const m of members) {
      edges.push({ id: rid('e'), source: leadId, target: m.id as string })
    }
  }

  const edgePairs = edges.map((e) => ({
    source: String(e.source),
    target: String(e.target),
  }))
  if (detectCycle(edgePairs)) {
    throw new Error('meta-agent returned edges with a cycle')
  }

  const slug = slugify(name)
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`generated team slug is not filesystem-safe: ${slug}`)
  }

  return {
    id: rid('t'),
    slug,
    name,
    agents: ordered,
    edges,
    entry_agent_id: null,
    allowed_skills: [],
    limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
  }
}

teams.post('/generate', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as GenerateBody
  const description = body.description?.trim()
  if (!description) {
    return c.json({ detail: 'description is required' }, 400)
  }
  if (typeof body.company_slug !== 'string' || !body.company_slug) {
    return c.json({ detail: 'company_slug required' }, 400)
  }
  if (!SAFE_SLUG.test(body.company_slug)) {
    return c.json({ detail: 'invalid company_slug' }, 400)
  }
  try {
    const text = await chatCompletion({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: META_SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
      temperature: 0.4,
    })
    const meta = extractJson(text)
    const team = buildTeamYaml(meta, description)
    saveTeam(body.company_slug, team)
    return c.json(team)
  } catch (exc) {
    return c.json({ detail: exc instanceof Error ? exc.message : String(exc) }, 500)
  }
})

// ---------- helpers ----------

function teamNotFound(teamId: string) {
  return { detail: `team not found: ${teamId}` }
}

// ---------- /:teamId/dashboard ----------

interface SaveLayoutBody {
  layout?: Record<string, unknown>
}

teams.get('/:teamId/dashboard', (c) => {
  const teamId = c.req.param('teamId')
  const resolved = resolveTeamSlugs(teamId)
  if (!resolved) return c.json(teamNotFound(teamId), 404)
  const layout = loadDashboard(resolved.companySlug, resolved.teamSlug)
  return c.json({ layout })
})

teams.put('/:teamId/dashboard', async (c) => {
  const teamId = c.req.param('teamId')
  const resolved = resolveTeamSlugs(teamId)
  if (!resolved) return c.json(teamNotFound(teamId), 404)
  const body = (await c.req.json().catch(() => ({}))) as SaveLayoutBody
  if (!body.layout || typeof body.layout !== 'object') {
    return c.json({ detail: 'layout required' }, 400)
  }
  saveDashboard(resolved.companySlug, resolved.teamSlug, body.layout)
  return c.json({ ok: true })
})

// ---------- /:teamId/exec ----------

interface SqlBody {
  sql?: string
}

teams.post('/:teamId/exec', async (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  const body = (await c.req.json().catch(() => ({}))) as SqlBody
  if (typeof body.sql !== 'string' || !body.sql.trim()) {
    return c.json({ detail: 'sql required' }, 400)
  }
  try {
    return c.json(runExec(r.companySlug, r.teamSlug, body.sql, { source: 'manual' }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 400)
  }
})

// ---------- /:teamId/files ----------

teams.get('/:teamId/files', (c) => {
  const teamId = c.req.param('teamId')
  const rel = c.req.query('path') ?? ''
  try {
    return c.json(listFiles(teamId, rel))
  } catch (err) {
    if (err instanceof FilesError) {
      return c.json({ detail: err.message }, err.statusCode as Parameters<typeof c.json>[1])
    }
    throw err
  }
})

// ---------- /:teamId/files/read ----------

teams.get('/:teamId/files/read', (c) => {
  const teamId = c.req.param('teamId')
  const rel = c.req.query('path')
  if (!rel) {
    return c.json({ detail: 'path query required' }, 400)
  }
  try {
    return c.json(readFile(teamId, rel))
  } catch (err) {
    if (err instanceof FilesError) {
      return c.json({ detail: err.message }, err.statusCode as Parameters<typeof c.json>[1])
    }
    throw err
  }
})

// ---------- /:teamId/messages ----------

interface AppendMessageBody {
  id?: string
  from_id?: string
  text?: string
  session_id?: string | null
  created_at?: number | null
}

teams.get('/:teamId/messages', (c) => {
  const teamId = c.req.param('teamId')
  return c.json(listForTeam(teamId))
})

teams.post('/:teamId/messages', async (c) => {
  const teamId = c.req.param('teamId')
  const body = (await c.req.json().catch(() => ({}))) as AppendMessageBody
  if (!body.id || !body.from_id || typeof body.text !== 'string') {
    return c.json({ detail: 'id, from_id, text required' }, 400)
  }
  const record: MessageRecord = {
    id: body.id,
    team_id: teamId,
    from_id: body.from_id,
    text: body.text,
    session_id: body.session_id ?? null,
    created_at: body.created_at ?? nowTs(),
  }
  saveMessage(record)
  return c.json({ ok: true })
})

teams.delete('/:teamId/messages', (c) => {
  const teamId = c.req.param('teamId')
  const cleared = clearTeam(teamId)
  return c.json({ ok: true, cleared })
})

// ---------- /:teamId/query ----------

teams.post('/:teamId/query', async (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  const body = (await c.req.json().catch(() => ({}))) as SqlBody
  if (typeof body.sql !== 'string' || !body.sql.trim()) {
    return c.json({ detail: 'sql required' }, 400)
  }
  try {
    return c.json(runQuery(r.companySlug, r.teamSlug, body.sql))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 400)
  }
})

// ---------- /:teamId/schema ----------

teams.get('/:teamId/schema', (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  return c.json(describeSchema(r.companySlug, r.teamSlug))
})

// ---------- /:teamId/snapshot ----------

teams.get('/:teamId/snapshot', (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  return c.json({ exists: hasSnapshot(r.companySlug, r.teamSlug) })
})

teams.post('/:teamId/snapshot', (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  return c.json({
    ok: true,
    files: createSnapshot(r.companySlug, r.teamSlug),
  })
})

teams.delete('/:teamId/snapshot', (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  return c.json({ ok: discardSnapshot(r.companySlug, r.teamSlug) })
})

// ---------- /:teamId/snapshot/restore ----------

teams.post('/:teamId/snapshot/restore', (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  return c.json(restoreSnapshot(r.companySlug, r.teamSlug))
})

// ---------- /:teamId/table/:tableName ----------

const SAFE_TABLE = /^[A-Za-z0-9_]+$/

teams.get('/:teamId/table/:tableName', (c) => {
  const teamId = c.req.param('teamId')
  const tableName = c.req.param('tableName')
  if (!SAFE_TABLE.test(tableName)) {
    return c.json({ detail: 'invalid table name' }, 400)
  }
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  const limit = Math.max(
    1,
    Math.min(1000, Number.parseInt(c.req.query('limit') ?? '100', 10) || 100),
  )
  const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0)
  const pageSql = `SELECT * FROM ${tableName} ORDER BY rowid DESC LIMIT ${limit} OFFSET ${offset}`
  const page = runQuery(r.companySlug, r.teamSlug, pageSql)
  const countSql = `SELECT COUNT(*) AS c FROM ${tableName}`
  const countRes = runQuery(r.companySlug, r.teamSlug, countSql)
  const total = Number((countRes.rows[0] ?? { c: 0 }).c ?? 0)
  return c.json({
    columns: page.columns,
    rows: page.rows,
    total,
    limit,
    offset,
  })
})

// ---------- /:teamId/templates/install ----------

interface InstallTemplateBody {
  template?: string
}

teams.post('/:teamId/templates/install', async (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  const body = (await c.req.json().catch(() => ({}))) as InstallTemplateBody
  if (typeof body.template !== 'string' || !body.template.trim()) {
    return c.json({ detail: 'template name required' }, 400)
  }
  try {
    return c.json(installTemplate(r.companySlug, r.teamSlug, body.template))
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return c.json({ detail: message }, status)
  }
})
