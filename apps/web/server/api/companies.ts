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
  const order = Array.isArray(body.order) ? body.order.filter((s): s is string => typeof s === 'string') : null
  if (!order) return c.json({ detail: 'order: string[] required' }, 400)
  reorderCompanies(order)
  return c.json({ ok: true })
})

// PUT /api/companies/:companySlug/teams/reorder — { order: slug[] }
companies.put('/:companySlug/teams/reorder', async (c) => {
  const companySlug = c.req.param('companySlug')
  const body = (await c.req.json().catch(() => ({}))) as { order?: unknown }
  const order = Array.isArray(body.order) ? body.order.filter((s): s is string => typeof s === 'string') : null
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
  return c.json({ ok: true })
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
