/**
 * Team Frame — portable, single-file team package.
 * Ports apps/server/openhive/persistence/frames.py.
 *
 * Beekeeping analogy: a "frame" is the modular slab of comb a beekeeper lifts
 * from one hive and slots into another. Our Frame does the same for teams —
 * serialise everything needed to reproduce a team into one YAML blob, then
 * instantiate it on demand.
 *
 * Contract: format and on-disk side effects match Python byte-for-byte so
 * frames exported by one runtime install cleanly in the other.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import yaml from 'js-yaml'
import { companyDir, packagesRoot, teamYamlPath } from './paths'
import { saveTeam, type TeamDict } from './companies'
import { loadDashboard, saveDashboard } from './dashboards'
import { companyDbPath, withCompanyDb } from './team-data'
import {
  ANTHROPIC_MODELS,
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
  OPENAI_MODELS,
  VERTEX_MODELS,
} from './providers/models'

function defaultModelFor(providerId: string): string {
  if (providerId === 'claude-code') {
    return CLAUDE_CODE_MODELS.find((m) => m.default)?.id ?? CLAUDE_CODE_MODELS[0]?.id ?? ''
  }
  if (providerId === 'anthropic') {
    return ANTHROPIC_MODELS.find((m) => m.default)?.id ?? ANTHROPIC_MODELS[0]?.id ?? ''
  }
  if (providerId === 'codex') {
    return CODEX_MODELS.find((m) => m.default)?.id ?? CODEX_MODELS[0]?.id ?? ''
  }
  if (providerId === 'openai') {
    return OPENAI_MODELS.find((m) => m.default)?.id ?? OPENAI_MODELS[0]?.id ?? ''
  }
  if (providerId === 'gemini') {
    return GEMINI_MODELS.find((m) => m.default)?.id ?? GEMINI_MODELS[0]?.id ?? ''
  }
  if (providerId === 'vertex-ai') {
    return VERTEX_MODELS.find((m) => m.default)?.id ?? VERTEX_MODELS[0]?.id ?? ''
  }
  if (providerId === 'copilot') return 'gpt-5-mini'
  return ''
}

const FRAME_VERSION = 1

const SLUG_RE = /[^a-z0-9-]+/g

function slugify(text: string, fallback = 'team'): string {
  const s = text.toLowerCase().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '')
  return s || fallback
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(3).toString('hex')}`
}

// -------- export --------

function readYamlSafe(file: string): Record<string, unknown> | null {
  try {
    const raw = yaml.load(fs.readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    return raw as Record<string, unknown>
  } catch {
    return null
  }
}

function personaNameFromMd(md: string): string | null {
  if (!md.startsWith('---')) return null
  const end = md.indexOf('\n---', 3)
  if (end < 0) return null
  const block = md.slice(3, end)
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    if (key === 'name') {
      return line.slice(idx + 1).trim().replace(/^["']|["']$/g, '') || null
    }
  }
  return null
}

function bundlePersonaFiles(pathRef: string): Record<string, string> {
  // Returns { relpath: content, __name__: personaName }. Empty on unreadable.
  const resolved = pathRef.startsWith('~')
    ? path.join(
        process.env.HOME ?? path.parse(process.cwd()).root,
        pathRef.slice(1),
      )
    : pathRef
  const out: Record<string, string> = {}
  try {
    const stat = fs.statSync(resolved)
    if (stat.isFile() && resolved.endsWith('.md')) {
      const text = fs.readFileSync(resolved, 'utf8')
      out[path.basename(resolved)] = text
      out.__name__ = personaNameFromMd(text) ?? path.basename(resolved, '.md')
      return out
    }
    if (!stat.isDirectory()) return {}
  } catch {
    return {}
  }
  const agentMd = path.join(resolved, 'AGENT.md')
  if (!fs.existsSync(agentMd) || !fs.statSync(agentMd).isFile()) return {}
  const TEXT_EXTS = new Set(['.md', '.yaml', '.yml', '.txt', '.json'])
  const MAX_BYTES = 128 * 1024
  const SKIP = new Set(['__pycache__', '.git', 'node_modules', '.venv', 'venv'])

  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      const relNext = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(abs, relNext)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!TEXT_EXTS.has(ext)) continue
        try {
          const data = fs.readFileSync(abs, 'utf8')
          if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) continue
          out[relNext] = data
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  walk(resolved, '')
  const agent = out['AGENT.md'] ?? ''
  out.__name__ = personaNameFromMd(agent) ?? path.basename(resolved)
  return out
}

function extractSchema(companySlug: string, teamId: string): string[] {
  // Company DB holds every team's DDL history. Filter the schema_migrations
  // stream to rows tagged with this team plus any company-wide rows (null
  // team_id) so the exported frame ships a complete schema snapshot.
  const dbFile = companyDbPath(companySlug)
  if (!fs.existsSync(dbFile)) return []
  return withCompanyDb(companySlug, (conn) => {
    const rows = conn
      .prepare(
        `SELECT sql FROM schema_migrations
          WHERE team_id = :team_id OR team_id IS NULL
          ORDER BY id ASC`,
      )
      .all({ team_id: teamId }) as { sql: string | null }[]
    return rows
      .map((r) => (r.sql ?? '').trim())
      .filter((s) => s.length > 0)
  })
}

interface Frame {
  openhive_frame: 1
  name: string
  description: string
  version: string
  created_at: string
  tags: string[]
  team: {
    name: string
    agents: Record<string, unknown>[]
    edges: { source: number; target: number }[]
    entry_agent_index: number | null
    allowed_skills: string[]
  }
  dashboard: Record<string, unknown> | null
  data_schema: string[]
  persona_assets: Record<
    string,
    { files: Record<string, string>; name: string }
  >
  requires: { skills: string[]; providers: string[] }
}

export function buildFrame(companySlug: string, teamSlug: string): Frame {
  const teamPath = teamYamlPath(companySlug, teamSlug)
  if (!fs.existsSync(teamPath) || !fs.statSync(teamPath).isFile()) {
    const err = new Error(`team not found: ${companySlug}/${teamSlug}`)
    ;(err as Error & { code?: string }).code = 'ENOENT'
    throw err
  }
  const team = readYamlSafe(teamPath)
  if (!team) throw new Error('team yaml is empty or invalid')

  const rawAgents = Array.isArray(team.agents) ? (team.agents as unknown[]) : []
  const idToIdx = new Map<string, number>()
  const agentsOut: Record<string, unknown>[] = []
  rawAgents.forEach((a, idx) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return
    const aObj = a as Record<string, unknown>
    const origId = typeof aObj.id === 'string' ? aObj.id : ''
    if (origId) idToIdx.set(origId, idx)
    const copy: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(aObj)) {
      if (k !== 'id') copy[k] = v
    }
    agentsOut.push(copy)
  })

  const edgesOut: { source: number; target: number }[] = []
  for (const e of (team.edges as unknown[] | undefined) ?? []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const eObj = e as Record<string, unknown>
    const src = idToIdx.get(String(eObj.source ?? ''))
    const tgt = idToIdx.get(String(eObj.target ?? ''))
    if (src === undefined || tgt === undefined) continue
    edgesOut.push({ source: src, target: tgt })
  }

  let entryIdx: number | null = null
  const eid = team.entry_agent_id
  if (typeof eid === 'string' && idToIdx.has(eid)) {
    entryIdx = idToIdx.get(eid) ?? null
  }

  const dashboard = stripProjectIds(loadDashboard(companySlug, teamSlug))
  const teamIdForSchema =
    typeof team.id === 'string' && team.id ? team.id : teamSlug
  const dataSchema = extractSchema(companySlug, teamIdForSchema)

  const skillsRequired = new Set<string>()
  const providersRequired = new Set<string>()
  for (const a of agentsOut) {
    for (const s of (a.skills as unknown[] | undefined) ?? []) {
      if (typeof s === 'string') skillsRequired.add(s)
    }
    if (typeof a.provider_id === 'string' && a.provider_id) {
      providersRequired.add(a.provider_id)
    }
  }
  for (const s of (team.allowed_skills as unknown[] | undefined) ?? []) {
    if (typeof s === 'string') skillsRequired.add(s)
  }

  const personaAssets: Record<
    string,
    { files: Record<string, string>; name: string }
  > = {}
  for (const agent of agentsOut) {
    const pathRef = agent.persona_path
    if (typeof pathRef !== 'string' || !pathRef) continue
    let files: Record<string, string>
    try {
      files = bundlePersonaFiles(pathRef)
    } catch {
      continue
    }
    if (Object.keys(files).length === 0) continue
    const baseSlug = slugify(
      files.__name__ ?? path.basename(pathRef, path.extname(pathRef)),
      'persona',
    )
    let key = baseSlug
    let n = 1
    while (personaAssets[key]) {
      n += 1
      key = `${baseSlug}-${n}`
    }
    const stripped: Record<string, string> = {}
    for (const [k, v] of Object.entries(files)) {
      if (!k.startsWith('__')) stripped[k] = v
    }
    personaAssets[key] = { files: stripped, name: files.__name__ ?? baseSlug }
    agent.persona_bundle_key = key
    delete agent.persona_path
  }

  return {
    openhive_frame: FRAME_VERSION,
    name: (team.name as string | undefined) ?? teamSlug,
    description: '',
    version: '1.0.0',
    created_at: new Date().toISOString(),
    tags: [],
    team: {
      name: (team.name as string | undefined) ?? teamSlug,
      agents: agentsOut,
      edges: edgesOut,
      entry_agent_index: entryIdx,
      allowed_skills: [...((team.allowed_skills as string[] | undefined) ?? [])],
    },
    dashboard,
    data_schema: dataSchema,
    persona_assets: personaAssets,
    requires: {
      skills: [...skillsRequired].sort(),
      providers: [...providersRequired].sort(),
    },
  }
}

// -------- install --------

interface InstallOpts {
  connectedProviders?: Set<string>
  installedSkills?: Set<string>
}

interface InstalledTeam extends Record<string, unknown> {
  id: string
  slug: string
  name: string
  agents: Record<string, unknown>[]
  edges: { id: string; source: string; target: string }[]
  entry_agent_id: string | null
  allowed_skills: string[]
}

interface InstallResult {
  team: InstalledTeam
  warnings: string[]
}

export function installFrame(
  targetCompanySlug: string,
  frame: unknown,
  opts: InstallOpts = {},
): InstallResult {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('frame must be an object')
  }
  const fObj = frame as Record<string, unknown>
  if (fObj.openhive_frame !== FRAME_VERSION) {
    throw new Error(
      `unsupported frame version: ${JSON.stringify(fObj.openhive_frame)} (expected ${FRAME_VERSION})`,
    )
  }
  const teamBlock = fObj.team
  if (!teamBlock || typeof teamBlock !== 'object' || Array.isArray(teamBlock)) {
    throw new Error('frame.team is missing or invalid')
  }
  const teamObj = teamBlock as Record<string, unknown>

  const compDir = companyDir(targetCompanySlug)
  if (
    !fs.existsSync(path.join(compDir, 'company.yaml')) ||
    !fs.statSync(path.join(compDir, 'company.yaml')).isFile()
  ) {
    const err = new Error(`target company not found: ${targetCompanySlug}`)
    ;(err as Error & { code?: string }).code = 'ENOENT'
    throw err
  }

  // Pick a fresh team slug.
  const baseSlug = slugify(String(teamObj.name ?? 'team'))
  const teamsDir = path.join(compDir, 'teams')
  fs.mkdirSync(teamsDir, { recursive: true })
  let teamSlug = baseSlug
  let n = 1
  while (fs.existsSync(path.join(teamsDir, `${teamSlug}.yaml`))) {
    n += 1
    teamSlug = `${baseSlug}-${n}`
  }

  const teamId = newId('t')

  const warnings: string[] = []
  const requires = (fObj.requires as Record<string, unknown> | undefined) ?? {}
  const skillsRequired = new Set<string>(
    Array.isArray(requires.skills)
      ? (requires.skills as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
  )
  // providersRequired is computed but currently only used for agent remapping;
  // the dedicated warning-loop in the Python version is a no-op, so we skip it
  // here too (dropping it clears a dead-branch lint warning).

  let fallbackProvider: string | null = null
  if (opts.connectedProviders && opts.connectedProviders.size > 0) {
    fallbackProvider = [...opts.connectedProviders].sort()[0] ?? null
  }

  // Unpack persona asset bundles.
  const personaBundlePaths = new Map<string, string>()
  const rawAssets = (fObj.persona_assets as Record<string, unknown> | undefined) ?? {}
  if (rawAssets && typeof rawAssets === 'object' && !Array.isArray(rawAssets)) {
    const agentsDir = path.join(compDir, 'agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    for (const [key, payloadRaw] of Object.entries(rawAssets)) {
      if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) continue
      const payload = payloadRaw as Record<string, unknown>
      const files = payload.files
      if (!files || typeof files !== 'object' || Array.isArray(files)) continue
      const slugBase = slugify(
        String(payload.name ?? key),
        'persona',
      )
      let target = path.join(agentsDir, slugBase)
      let m = 1
      while (fs.existsSync(target)) {
        m += 1
        target = path.join(agentsDir, `${slugBase}-${m}`)
      }
      fs.mkdirSync(target, { recursive: true })
      for (const [rel, textRaw] of Object.entries(
        files as Record<string, unknown>,
      )) {
        if (typeof rel !== 'string' || typeof textRaw !== 'string') continue
        const safeRel = rel.replace(/^\/+/, '')
        if (safeRel.split('/').some((p) => p === '..')) continue
        const dst = path.join(target, safeRel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.writeFileSync(dst, textRaw, 'utf8')
      }
      personaBundlePaths.set(key, target)
    }
  }

  const srcAgents = Array.isArray(teamObj.agents) ? (teamObj.agents as unknown[]) : []
  const newAgentIds: string[] = []
  const outAgents: Record<string, unknown>[] = []

  for (const a of srcAgents) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue
    const id = newId('a')
    newAgentIds.push(id)
    const agent: Record<string, unknown> = { ...(a as Record<string, unknown>), id }
    const bundleKey = agent.persona_bundle_key
    delete agent.persona_bundle_key
    if (typeof bundleKey === 'string' && personaBundlePaths.has(bundleKey)) {
      agent.persona_path = personaBundlePaths.get(bundleKey)
    }
    const prov = agent.provider_id
    const hasProv = typeof prov === 'string' && prov.length > 0
    if (
      opts.connectedProviders &&
      hasProv &&
      !opts.connectedProviders.has(prov as string)
    ) {
      if (fallbackProvider) {
        warnings.push(
          `Agent '${agent.role ?? agent.label ?? id}' used provider '${prov}' ` +
            `which isn't connected — fell back to '${fallbackProvider}'. Update via the agent editor.`,
        )
        agent.provider_id = fallbackProvider
      } else {
        warnings.push(
          `Agent '${agent.role ?? agent.label ?? id}' used provider '${prov}' ` +
            `which isn't connected, and no other provider is connected either. Connect one in Settings.`,
        )
      }
    } else if (!hasProv && fallbackProvider) {
      // Frame didn't pin a provider — backfill from whatever the user has
      // connected so preflight doesn't reject the run.
      agent.provider_id = fallbackProvider
    }
    // Backfill model if the frame left it blank. Picks the provider's default
    // from the catalog; the user can still swap it in the node editor.
    const chosenProv =
      typeof agent.provider_id === 'string' ? agent.provider_id : ''
    if (
      chosenProv &&
      (typeof agent.model !== 'string' || agent.model.length === 0)
    ) {
      const def = defaultModelFor(chosenProv)
      if (def) agent.model = def
    }
    outAgents.push(agent)
  }

  const outEdges: { id: string; source: string; target: string }[] = []
  for (const e of (teamObj.edges as unknown[] | undefined) ?? []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const eObj = e as Record<string, unknown>
    const si = Number(eObj.source)
    const ti = Number(eObj.target)
    if (
      !Number.isInteger(si) ||
      !Number.isInteger(ti) ||
      si < 0 ||
      ti < 0 ||
      si >= newAgentIds.length ||
      ti >= newAgentIds.length
    ) {
      continue
    }
    outEdges.push({
      id: newId('e'),
      source: newAgentIds[si]!,
      target: newAgentIds[ti]!,
    })
  }

  let entryAgentId: string | null = null
  const entryIdx = teamObj.entry_agent_index
  if (
    typeof entryIdx === 'number' &&
    Number.isInteger(entryIdx) &&
    entryIdx >= 0 &&
    entryIdx < newAgentIds.length
  ) {
    entryAgentId = newAgentIds[entryIdx] ?? null
  }

  // Skill availability — if the caller didn't supply an installed-skills set,
  // conservatively report ALL required skills as missing (matches the Python
  // behaviour when the skills module fails to import).
  const installed = opts.installedSkills ?? new Set<string>()
  const missingSkills = [...skillsRequired]
    .filter((s) => !installed.has(s))
    .sort()
  for (const sk of missingSkills) {
    warnings.push(
      `Required skill '${sk}' is not installed in this hive. ` +
        `Agents that reference it will silently skip until you install it.`,
    )
  }

  const teamYaml: InstalledTeam = {
    id: teamId,
    slug: teamSlug,
    name: String(teamObj.name ?? teamSlug),
    agents: outAgents,
    edges: outEdges,
    entry_agent_id: entryAgentId,
    allowed_skills: [
      ...((teamObj.allowed_skills as string[] | undefined) ?? []),
    ],
  }
  saveTeam(targetCompanySlug, teamYaml as TeamDict)

  const dashboard = fObj.dashboard
  if (dashboard && typeof dashboard === 'object' && !Array.isArray(dashboard)) {
    saveDashboard(targetCompanySlug, teamSlug, dashboard as Record<string, unknown>)
  }

  // Data schema — replay each DDL block against the company DB. Each block
  // becomes one migration row tagged with the team we're installing into so
  // the schema origin is traceable post-merge.
  const schemaErrors: string[] = []
  for (const sql of (fObj.data_schema as unknown[] | undefined) ?? []) {
    if (typeof sql !== 'string' || !sql.trim()) continue
    try {
      withCompanyDb(targetCompanySlug, (conn) => {
        const tx = conn.transaction(() => {
          conn.exec(sql)
          conn
            .prepare(
              `INSERT INTO schema_migrations (applied_at, source, sql, note, team_id)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(Date.now(), 'frame_install', sql, null, teamId)
        })
        tx()
      })
    } catch (err) {
      const first = sql.split('\n')[0]?.slice(0, 60) ?? ''
      schemaErrors.push(`${first}… → ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const e of schemaErrors) {
    warnings.push(`Data schema statement failed: ${e}`)
  }

  return { team: teamYaml, warnings }
}

/** Scrub `project_id` out of every MCP panel binding before exporting the
 *  frame. The id alone isn't a credential (the access token lives in the
 *  installer's mcp.yaml, never in the frame), but it identifies the
 *  exporter's exact Supabase project — and if a recipient happens to be
 *  authenticated to the same organization, the SQL would silently run
 *  against that project on their install. Replacing it with a placeholder
 *  forces the install-time AI rebinder (or the user's manual edit) to fill
 *  it in for the new environment. SQL body, table names, and other args are
 *  preserved deliberately — they're useful as documentation and the user
 *  considers them low-risk. */
const PROJECT_ID_PLACEHOLDER = '<NEEDS_REBIND>'

function stripProjectIds<T>(dashboard: T): T {
  if (!dashboard || typeof dashboard !== 'object') return dashboard
  const d = dashboard as unknown as { blocks?: unknown }
  const blocks = Array.isArray(d.blocks) ? d.blocks : []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const block = b as { binding?: { source?: { kind?: unknown; config?: unknown } } }
    const src = block.binding?.source
    if (!src || src.kind !== 'mcp') continue
    const cfg = src.config
    if (!cfg || typeof cfg !== 'object') continue
    const args = (cfg as { args?: unknown }).args
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue
    const a = args as Record<string, unknown>
    if ('project_id' in a) a.project_id = PROJECT_ID_PLACEHOLDER
  }
  return dashboard
}
