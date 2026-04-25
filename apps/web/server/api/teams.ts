import { resolveTeamSlugs } from '@/lib/server/companies'
import {
  listDashboardBackups,
  loadDashboard,
  restoreDashboardBackup,
  saveDashboard,
} from '@/lib/server/dashboards'
import { FilesError, listFiles, readFile } from '@/lib/server/files'
import {
  type MessageRecord,
  clearTeam,
  listForTeam,
  nowTs,
  saveMessage,
} from '@/lib/server/messages'
import {
  createSnapshot,
  discardSnapshot,
  hasSnapshot,
  restoreSnapshot,
} from '@/lib/server/snapshots'
import { describeSchema, installTemplate, runExec, runQuery } from '@/lib/server/team-data'
import { Hono } from 'hono'

export const teams = new Hono()

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

// GET /api/teams/:teamId/dashboard/backups — list recent auto-saves
teams.get('/:teamId/dashboard/backups', (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  return c.json({ backups: listDashboardBackups(r.companySlug, r.teamSlug) })
})

// POST /api/teams/:teamId/dashboard/restore — body {name}
teams.post('/:teamId/dashboard/restore', async (c) => {
  const teamId = c.req.param('teamId')
  const r = resolveTeamSlugs(teamId)
  if (!r) return c.json(teamNotFound(teamId), 404)
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown }
  if (typeof body.name !== 'string') return c.json({ detail: 'name required' }, 400)
  const ok = restoreDashboardBackup(r.companySlug, r.teamSlug, body.name)
  if (!ok) return c.json({ detail: 'backup not found' }, 404)
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
    return c.json(runExec(r.companySlug, body.sql, { source: 'manual', teamId }))
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
    return c.json(runQuery(r.companySlug, body.sql, { teamId }))
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
  return c.json(describeSchema(r.companySlug, { teamId }))
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
  // Scope by team_id when the table carries the column (typical for user
  // tables post team→company merge). Schema-less tables (legacy) fall back
  // to the unscoped view so the inspector still works.
  const schema = describeSchema(r.companySlug)
  const hasTeamId =
    schema.tables.find((t) => t.name === tableName)?.columns.some((col) => col.name === 'team_id') ?? false
  const whereClause = hasTeamId ? 'WHERE team_id = :team_id' : ''
  const pageSql = `SELECT * FROM ${tableName} ${whereClause} ORDER BY rowid DESC LIMIT ${limit} OFFSET ${offset}`
  const page = runQuery(r.companySlug, pageSql, hasTeamId ? { teamId } : {})
  const countSql = `SELECT COUNT(*) AS c FROM ${tableName} ${whereClause}`
  const countRes = runQuery(r.companySlug, countSql, hasTeamId ? { teamId } : {})
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
    return c.json(installTemplate(r.companySlug, body.template, { teamId }))
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return c.json({ detail: message }, status)
  }
})
