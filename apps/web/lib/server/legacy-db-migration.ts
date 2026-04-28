/**
 * One-shot boot migration: read the legacy ~/.openhive/openhive.db and
 * explode its contents into per-session / per-team files, then rename the
 * DB file so it is no longer opened.
 *
 * This module is the ONLY server module that still opens the legacy DB.
 * Once it runs successfully, the DB file is renamed to
 * openhive.db.legacy-{ts}; subsequent boots find no DB and short-circuit.
 *
 * Team data.db files (under companies/{slug}/teams/{slug}/data.db) are NOT
 * touched — those stay SQLite.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'

import { dbPath, dataDir, companyDir } from './paths'
import {
  sessionDir,
  sessionEventsPath,
  sessionMetaPath,
  sessionArtifactsIndexPath,
  sessionUsagePath,
  sessionArtifactDir,
  type SessionMeta,
} from './sessions'

const DONE_MARKER = path.join(dataDir(), '.legacy-db-migrated')

export function needsMigration(): boolean {
  if (fs.existsSync(DONE_MARKER)) return false
  if (!fs.existsSync(dbPath())) return false
  return true
}

interface LegacySessionRow {
  id: string
  task_id: string | null
  team_id: string
  goal: string
  status: string
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
}

interface LegacyEventRow {
  session_id: string
  seq: number
  ts: number
  kind: string
  depth: number
  node_id: string | null
  tool_call_id: string | null
  tool_name: string | null
  data_json: string | null
}

interface LegacyArtifactRow {
  id: string
  session_id: string
  team_id: string
  company_slug: string | null
  team_slug: string | null
  skill_name: string | null
  filename: string
  path: string
  mime: string | null
  size: number | null
  created_at: number
}

interface LegacyUsageRow {
  ts: number
  session_id: string | null
  company_id: string | null
  team_id: string | null
  agent_id: string | null
  agent_role: string | null
  provider_id: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd_cents: number
  system_chars?: number
  tools_chars?: number
  history_chars?: number
}

interface LegacyMessageRow {
  id: string
  team_id: string
  from_id: string
  text: string
  session_id: string | null
  created_at: number
}

interface LegacyOAuthRow {
  provider_id: string
  access_token: string
  refresh_token: string | null
  expires_at: number | null
  scope: string | null
  account_label: string | null
  account_id: string | null
  created_at: number
  updated_at: number
}

interface LegacyPanelCacheRow {
  panel_id: string
  team_id: string
  data_json: string | null
  error: string | null
  fetched_at: number
  duration_ms: number | null
}

function tableExists(conn: BetterSqliteDatabase, name: string): boolean {
  const row = conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function statusForMeta(status: string, error: string | null): SessionMeta['status'] {
  if (status === 'running') return 'running'
  if (status === 'error' || (error && error !== 'interrupted' && error !== 'cancelled')) {
    return 'error'
  }
  // Legacy 'finished' / 'interrupted' / 'cancelled' all migrate to 'idle' —
  // the post-refactor model treats any non-running, non-errored session as
  // resumable. The original error string stays in `error` as a hint.
  return 'idle'
}

export function migrateLegacyDb(): {
  sessions: number
  events: number
  artifacts: number
  usageRows: number
  messages: number
  panels: number
  oauth: number
} {
  const file = dbPath()
  const conn = new Database(file, { readonly: true, fileMustExist: true })
  conn.pragma('query_only = ON')

  const counts = {
    sessions: 0,
    events: 0,
    artifacts: 0,
    usageRows: 0,
    messages: 0,
    panels: 0,
    oauth: 0,
  }

  // ---- sessions + meta.json ----
  if (tableExists(conn, 'sessions')) {
    const rows = conn
      .prepare(
        `SELECT id, task_id, team_id, goal, status, output, error, started_at, finished_at
           FROM sessions`,
      )
      .all() as LegacySessionRow[]
    for (const row of rows) {
      fs.mkdirSync(sessionDir(row.id), { recursive: true })
      const meta: SessionMeta = {
        id: row.id,
        task_id: row.task_id,
        team_id: row.team_id,
        goal: row.goal,
        status: statusForMeta(row.status, row.error),
        output: row.output,
        error: row.error,
        started_at: row.started_at,
        finished_at: row.finished_at,
        artifact_count: 0,
      }
      fs.writeFileSync(sessionMetaPath(row.id), JSON.stringify(meta, null, 2), 'utf8')
      counts.sessions += 1
    }
  }

  // ---- session_events → events.jsonl ----
  if (tableExists(conn, 'session_events')) {
    // Group by session so we can write each file once in one go.
    const bySession = new Map<string, LegacyEventRow[]>()
    const rows = conn
      .prepare(
        `SELECT session_id, seq, ts, kind, depth, node_id, tool_call_id, tool_name, data_json
           FROM session_events ORDER BY session_id, seq ASC`,
      )
      .all() as LegacyEventRow[]
    for (const r of rows) {
      const list = bySession.get(r.session_id) ?? []
      list.push(r)
      bySession.set(r.session_id, list)
    }
    for (const [sessionId, evs] of bySession.entries()) {
      fs.mkdirSync(sessionDir(sessionId), { recursive: true })
      const text = `${evs.map((e) => JSON.stringify(e)).join('\n')}\n`
      fs.writeFileSync(sessionEventsPath(sessionId), text, 'utf8')
      counts.events += evs.length
    }
  }

  // ---- artifacts → per-session artifacts.json ----
  if (tableExists(conn, 'artifacts')) {
    const rows = conn
      .prepare(
        `SELECT id, session_id, team_id, company_slug, team_slug, skill_name,
                filename, path, mime, size, created_at
           FROM artifacts`,
      )
      .all() as LegacyArtifactRow[]
    const bySession = new Map<string, LegacyArtifactRow[]>()
    for (const r of rows) {
      const list = bySession.get(r.session_id) ?? []
      list.push(r)
      bySession.set(r.session_id, list)
    }
    for (const [sessionId, arts] of bySession.entries()) {
      fs.mkdirSync(sessionDir(sessionId), { recursive: true })
      fs.writeFileSync(
        sessionArtifactsIndexPath(sessionId),
        JSON.stringify(arts, null, 2),
        'utf8',
      )
      counts.artifacts += arts.length
    }
  }

  // ---- usage_logs → per-session usage.json (aggregated) ----
  if (tableExists(conn, 'usage_logs')) {
    const cols = conn
      .prepare('PRAGMA table_info(usage_logs)')
      .all() as { name: string }[]
    const colNames = new Set(cols.map((c) => c.name))
    const sysCharsCol = colNames.has('system_chars') ? ', system_chars' : ', 0 AS system_chars'
    const toolsCharsCol = colNames.has('tools_chars') ? ', tools_chars' : ', 0 AS tools_chars'
    const histCharsCol = colNames.has('history_chars') ? ', history_chars' : ', 0 AS history_chars'

    const rows = conn
      .prepare(
        `SELECT ts, session_id, company_id, team_id, agent_id, agent_role,
                provider_id, model,
                input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens,
                cost_usd_cents
                ${sysCharsCol} ${toolsCharsCol} ${histCharsCol}
           FROM usage_logs`,
      )
      .all() as LegacyUsageRow[]

    const bySession = new Map<string, LegacyUsageRow[]>()
    for (const r of rows) {
      if (!r.session_id) continue
      const list = bySession.get(r.session_id) ?? []
      list.push(r)
      bySession.set(r.session_id, list)
    }
    for (const [sessionId, usages] of bySession.entries()) {
      fs.mkdirSync(sessionDir(sessionId), { recursive: true })
      fs.writeFileSync(sessionUsagePath(sessionId), JSON.stringify(usages, null, 2), 'utf8')
      counts.usageRows += usages.length
    }
  }

  // ---- messages → per-team chat.jsonl ----
  if (tableExists(conn, 'messages')) {
    const rows = conn
      .prepare(
        `SELECT id, team_id, from_id, text, session_id, created_at
           FROM messages ORDER BY team_id, created_at ASC`,
      )
      .all() as LegacyMessageRow[]
    const byTeam = new Map<string, LegacyMessageRow[]>()
    for (const r of rows) {
      const list = byTeam.get(r.team_id) ?? []
      list.push(r)
      byTeam.set(r.team_id, list)
    }
    for (const [teamId, msgs] of byTeam.entries()) {
      const p = teamChatPathByTeamId(teamId)
      if (!p) continue
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const text = `${msgs.map((m) => JSON.stringify(m)).join('\n')}\n`
      fs.writeFileSync(p, text, 'utf8')
      counts.messages += msgs.length
    }
  }

  // ---- panel_cache → cache/panels/{id}.json ----
  if (tableExists(conn, 'panel_cache')) {
    const rows = conn
      .prepare(
        `SELECT panel_id, team_id, data_json, error, fetched_at, duration_ms
           FROM panel_cache`,
      )
      .all() as LegacyPanelCacheRow[]
    const cacheRoot = path.join(dataDir(), 'cache', 'panels')
    fs.mkdirSync(cacheRoot, { recursive: true })
    for (const r of rows) {
      const safe = r.panel_id.replace(/[^a-zA-Z0-9_.-]/g, '_')
      fs.writeFileSync(
        path.join(cacheRoot, `${safe}.json`),
        JSON.stringify(r, null, 2),
        'utf8',
      )
      counts.panels += 1
    }
  }

  // ---- oauth_tokens → oauth.enc.json ----
  if (tableExists(conn, 'oauth_tokens')) {
    const rows = conn
      .prepare(
        `SELECT provider_id, access_token, refresh_token, expires_at, scope,
                account_label, account_id, created_at, updated_at
           FROM oauth_tokens`,
      )
      .all() as LegacyOAuthRow[]
    // Tokens are already Fernet-encrypted in the DB (stored as-is). Keep them
    // wrapped the same way in the new JSON file — decryption happens at read
    // time inside lib/server/auth/*.
    const out: Record<string, LegacyOAuthRow> = {}
    for (const r of rows) out[r.provider_id] = r
    fs.writeFileSync(
      path.join(dataDir(), 'oauth.enc.json'),
      JSON.stringify(out, null, 2),
      'utf8',
    )
    counts.oauth = rows.length
  }

  conn.close()

  // Rename legacy DB so it's never re-opened, plus drop the marker.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const legacyDest = `${file}.legacy-${stamp}`
  try { fs.renameSync(file, legacyDest) } catch { /* best-effort */ }
  for (const suffix of ['-wal', '-shm']) {
    const extra = `${file}${suffix}`
    if (fs.existsSync(extra)) {
      try { fs.renameSync(extra, `${legacyDest}${suffix}`) } catch { /* ignore */ }
    }
  }

  fs.writeFileSync(
    DONE_MARKER,
    JSON.stringify({ migratedAt: Date.now(), counts, legacyDb: legacyDest }, null, 2),
    'utf8',
  )

  return counts
}

/** Resolve team id → team's chat.jsonl path by reading company.yaml files.
 *  Returns null if the team can't be located (orphan message rows). */
function teamChatPathByTeamId(teamId: string): string | null {
  // Lazy: walk companies/*/teams/*/team.yaml, match by `id: teamId`.
  const root = path.join(dataDir(), 'companies')
  if (!fs.existsSync(root)) return null
  const companies = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const c of companies) {
    const teamsRoot = path.join(companyDir(c.name), 'teams')
    if (!fs.existsSync(teamsRoot)) continue
    const teams = fs.readdirSync(teamsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
    for (const t of teams) {
      const yamlPath = path.join(teamsRoot, t.name, 'team.yaml')
      try {
        const txt = fs.readFileSync(yamlPath, 'utf8')
        if (new RegExp(`^id:\\s*['\"]?${teamId}['\"]?\\s*$`, 'm').test(txt)) {
          return path.join(teamsRoot, t.name, 'chat.jsonl')
        }
      } catch { /* skip */ }
    }
  }
  // Fallback: dump to a sidecar orphan file so nothing is lost.
  const orphan = path.join(dataDir(), 'cache', 'orphan-messages', `${teamId}.jsonl`)
  return orphan
}

/** Generate a random-but-stable new session id. Engine uses this via
 *  session-registry at the top of runTeam; we export it here so the legacy
 *  migration can also mint ids for rows that somehow lacked one. */
function newSessionId(): string {
  return `session_${crypto.randomBytes(6).toString('hex')}`
}
