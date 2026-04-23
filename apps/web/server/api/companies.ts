import fs from 'node:fs'
import { buildAgentFrame, installAgentFrame } from '@/lib/server/agent-frames'
import {
  type CompanyDict,
  type TeamDict,
  deleteCompany,
  deleteTeam,
  listCompanies,
  reorderCompanies,
  reorderTeams,
  saveCompany,
  saveTeam,
} from '@/lib/server/companies'
import { buildFrame, installFrame } from '@/lib/server/frames'
import { isLedgerDisabled } from '@/lib/server/ledger/db'
import { readLedgerEntry, searchLedger } from '@/lib/server/ledger/read'
import { companyDir } from '@/lib/server/paths'
import { listConnected } from '@/lib/server/tokens'
import { Hono } from 'hono'
import yaml from 'js-yaml'

export const companies = new Hono()

interface SaveCompanyBody {
  company?: CompanyDict
}

interface SaveTeamBody {
  team?: TeamDict
}

interface InstallBody {
  frame?: unknown
}

const FILENAME_SAFE = /[^A-Za-z0-9._-]+/g

function safeFilename(name: string, suffix: string, fallback: string): string {
  const base = name.replace(FILENAME_SAFE, '-').replace(/^-+|-+$/g, '') || fallback
  return `${base}.${suffix}.yaml`
}

// GET /api/companies — list
companies.get('/', (c) => c.json(listCompanies()))

// PUT /api/companies — save (create or update)
companies.put('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SaveCompanyBody
  const company = body?.company
  if (!company || typeof company !== 'object') {
    return c.json({ detail: 'company body required' }, 400)
  }
  if (!company.slug && !company.id) {
    return c.json({ detail: 'company.slug or company.id required' }, 400)
  }
  saveCompany(company)
  return c.json({ ok: true })
})

// PUT /api/companies/reorder — { order: slug[] }
companies.put('/reorder', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { order?: unknown }
  const order = Array.isArray(body.order)
    ? body.order.filter((s): s is string => typeof s === 'string')
    : null
  if (!order) return c.json({ detail: 'order: string[] required' }, 400)
  reorderCompanies(order)
  return c.json({ ok: true })
})

// PUT /api/companies/:companySlug/teams/reorder — { order: slug[] }
companies.put('/:companySlug/teams/reorder', async (c) => {
  const companySlug = c.req.param('companySlug')
  const body = (await c.req.json().catch(() => ({}))) as { order?: unknown }
  const order = Array.isArray(body.order)
    ? body.order.filter((s): s is string => typeof s === 'string')
    : null
  if (!order) return c.json({ detail: 'order: string[] required' }, 400)
  reorderTeams(companySlug, order)
  return c.json({ ok: true })
})

// DELETE /api/companies/:companySlug
companies.delete('/:companySlug', (c) => {
  const companySlug = c.req.param('companySlug')
  const ok = deleteCompany(companySlug)
  if (!ok) {
    return c.json({ detail: 'Company not found' }, 404)
  }
  return c.json({ ok: true })
})

// POST /api/companies/:companySlug/frames/install
companies.post('/:companySlug/frames/install', async (c) => {
  const companySlug = c.req.param('companySlug')
  const body = (await c.req.json().catch(() => ({}))) as InstallBody
  if (!body.frame) {
    return c.json({ detail: 'frame required' }, 400)
  }
  try {
    const result = installFrame(companySlug, body.frame, {
      connectedProviders: new Set(listConnected()),
    })
    return c.json(result)
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return c.json({ detail: message }, status)
  }
})

// PUT /api/companies/:companySlug/teams
companies.put('/:companySlug/teams', async (c) => {
  const companySlug = c.req.param('companySlug')
  const body = (await c.req.json().catch(() => ({}))) as SaveTeamBody
  const team = body?.team
  if (!team || typeof team !== 'object') {
    return c.json({ detail: 'team body required' }, 400)
  }
  if (!team.slug && !team.id) {
    return c.json({ detail: 'team.slug or team.id required' }, 400)
  }
  saveTeam(companySlug, team)
  // Return the post-save team so the client can pick up fields the server
  // filled in (e.g. persona_path / persona_name after ensureAgentBundle).
  return c.json({ ok: true, team })
})

// DELETE /api/companies/:companySlug/teams/:teamSlug
companies.delete('/:companySlug/teams/:teamSlug', (c) => {
  const companySlug = c.req.param('companySlug')
  const teamSlug = c.req.param('teamSlug')
  const ok = deleteTeam(companySlug, teamSlug)
  if (!ok) {
    return c.json({ detail: 'Team not found' }, 404)
  }
  return c.json({ ok: true })
})

// GET /api/companies/:companySlug/teams/:teamSlug/frame
companies.get('/:companySlug/teams/:teamSlug/frame', (c) => {
  const companySlug = c.req.param('companySlug')
  const teamSlug = c.req.param('teamSlug')
  let frame: ReturnType<typeof buildFrame>
  try {
    frame = buildFrame(companySlug, teamSlug)
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return c.json({ detail: message }, status)
  }
  const body = yaml.dump(frame, { noRefs: true, sortKeys: false })
  const filename = safeFilename(frame.name || teamSlug, 'openhive-frame', 'team')
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-yaml',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})

// POST /api/companies/:companySlug/teams/:teamSlug/agents/install
companies.post('/:companySlug/teams/:teamSlug/agents/install', async (c) => {
  const companySlug = c.req.param('companySlug')
  const teamSlug = c.req.param('teamSlug')
  const body = (await c.req.json().catch(() => ({}))) as InstallBody
  if (!body.frame) {
    return c.json({ detail: 'frame required' }, 400)
  }
  try {
    const result = installAgentFrame(companySlug, teamSlug, body.frame, {
      connectedProviders: new Set(listConnected()),
    })
    return c.json(result)
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return c.json({ detail: message }, status)
  }
})

// GET /api/companies/:companySlug/teams/:teamSlug/agents/:agentId/frame
companies.get('/:companySlug/teams/:teamSlug/agents/:agentId/frame', (c) => {
  const companySlug = c.req.param('companySlug')
  const teamSlug = c.req.param('teamSlug')
  const agentId = c.req.param('agentId')
  let frame: ReturnType<typeof buildAgentFrame>
  try {
    frame = buildAgentFrame(companySlug, teamSlug, agentId)
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return c.json({ detail: message }, status)
  }
  const body = yaml.dump(frame, { noRefs: true, sortKeys: false })
  const filename = safeFilename(frame.name || agentId, 'openhive-agent-frame', 'agent')
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-yaml',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})

// ---------- S4: work ledger ----------

function companyExists(companySlug: string): boolean {
  try {
    return fs.statSync(companyDir(companySlug)).isDirectory()
  } catch {
    return false
  }
}

// GET /api/companies/:companySlug/ledger?q=...&domain=...&team_id=...&agent_role=...&since=...&limit=...
companies.get('/:companySlug/ledger', (c) => {
  const companySlug = c.req.param('companySlug')
  if (!companyExists(companySlug)) {
    return c.json({ detail: 'Company not found' }, 404)
  }
  if (isLedgerDisabled()) {
    return c.json({ results: [], total_matched: 0 })
  }
  const q = c.req.query('q') ?? ''
  if (!q) return c.json({ detail: 'query "q" required' }, 400)
  const limitRaw = c.req.query('limit')
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
  try {
    const result = searchLedger(companySlug, {
      query: q,
      domain: c.req.query('domain') || undefined,
      team_id: c.req.query('team_id') || undefined,
      agent_role: c.req.query('agent_role') || undefined,
      since: c.req.query('since') || undefined,
      limit,
    })
    return c.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Most common cause here is an FTS5 syntax error — treat as 400.
    return c.json({ detail: message }, 400)
  }
})

// GET /api/companies/:companySlug/ledger/:entryId
companies.get('/:companySlug/ledger/:entryId', (c) => {
  const companySlug = c.req.param('companySlug')
  const entryId = c.req.param('entryId')
  if (!companyExists(companySlug)) {
    return c.json({ detail: 'Company not found' }, 404)
  }
  if (isLedgerDisabled()) {
    return c.json({ detail: 'ledger disabled' }, 404)
  }
  try {
    return c.json(readLedgerEntry(companySlug, entryId))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('ledger entry not found')) {
      return c.json({ detail: message }, 404)
    }
    return c.json({ detail: message }, 500)
  }
})
