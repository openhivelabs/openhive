/**
 * Work ledger read path.
 *
 * Two operations: `searchLedger` (FTS5 match + filter + ORDER BY ts DESC) and
 * `readLedgerEntry` (single entry by id + body file). Both consumed by the
 * Lead-only tools in `tools.ts` and by the HTTP API in server/api/companies.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ledgerDir, withLedgerDb } from './db'

interface SearchArgs {
  query: string
  domain?: string
  team_id?: string
  agent_role?: string
  /** ISO date YYYY-MM-DD — entries strictly after midnight UTC of this day. */
  since?: string
  /** 1..50, default 10. */
  limit?: number
}

interface SearchHit {
  id: string
  ts: number
  agent_role: string
  team_id: string
  domain: string
  task: string
  summary: string
  artifact_paths: string[]
}

interface SearchResult {
  results: SearchHit[]
  total_matched: number
}

interface EntryMeta {
  id: string
  ts: number
  session_id: string
  team_id: string
  agent_id: string
  agent_role: string
  domain: string
  task: string
  summary: string
  status: string
}

interface EntryRead {
  full_body: string
  artifact_paths: string[]
  meta: EntryMeta
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 10
  return Math.min(Math.max(Math.trunc(raw), 1), 50)
}

export function searchLedger(companySlug: string, raw: SearchArgs): SearchResult {
  const limit = clampLimit(raw.limit)
  const sinceTs = raw.since ? Math.floor(Date.parse(raw.since) / 1000) : null
  const params: Record<string, unknown> = {
    query: raw.query,
    domain: raw.domain ?? null,
    team_id: raw.team_id ?? null,
    agent_role: raw.agent_role ?? null,
    since_ts: Number.isFinite(sinceTs as number) ? sinceTs : null,
    limit,
  }
  const filterSql = `
    WITH matched AS (
      SELECT rowid FROM entries_fts WHERE entries_fts MATCH @query
    )
    SELECT
      e.id, e.ts, e.agent_role, e.team_id, e.domain,
      substr(e.task, 1, 200) AS task,
      e.summary, e.artifact_paths
    FROM entries e
    JOIN matched m ON m.rowid = e.rowid
    WHERE (@domain IS NULL OR e.domain = @domain)
      AND (@team_id IS NULL OR e.team_id = @team_id)
      AND (@agent_role IS NULL OR e.agent_role = @agent_role)
      AND (@since_ts IS NULL OR e.ts >= @since_ts)
    ORDER BY e.ts DESC
    LIMIT @limit
  `
  const countSql = `
    SELECT COUNT(*) AS n
    FROM entries e
    JOIN entries_fts f ON f.rowid = e.rowid
    WHERE entries_fts MATCH @query
      AND (@domain IS NULL OR e.domain = @domain)
      AND (@team_id IS NULL OR e.team_id = @team_id)
      AND (@agent_role IS NULL OR e.agent_role = @agent_role)
      AND (@since_ts IS NULL OR e.ts >= @since_ts)
  `
  return withLedgerDb(companySlug, (db) => {
    let rows: Record<string, unknown>[] = []
    let total = 0
    try {
      rows = db.prepare(filterSql).all(params) as Record<string, unknown>[]
      const c = db.prepare(countSql).get(params) as { n: number } | undefined
      total = c?.n ?? 0
    } catch (e) {
      throw new Error(`ledger search failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return {
      results: rows.map((r) => ({
        id: String(r.id),
        ts: Number(r.ts),
        agent_role: String(r.agent_role),
        team_id: String(r.team_id),
        domain: String(r.domain),
        task: String(r.task),
        summary: String(r.summary),
        artifact_paths: JSON.parse(String(r.artifact_paths)) as string[],
      })),
      total_matched: total,
    }
  })
}

interface EntryRow extends EntryMeta {
  artifact_paths: string
  body_path: string
}

export function readLedgerEntry(companySlug: string, id: string): EntryRead {
  return withLedgerDb(companySlug, (db) => {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined
    if (!row) throw new Error(`ledger entry not found: ${id}`)
    const bodyAbs = path.join(ledgerDir(companySlug), row.body_path)
    const full_body = fs.readFileSync(bodyAbs, 'utf8')
    const meta: EntryMeta = {
      id: row.id,
      ts: row.ts,
      session_id: row.session_id,
      team_id: row.team_id,
      agent_id: row.agent_id,
      agent_role: row.agent_role,
      domain: row.domain,
      task: row.task,
      summary: row.summary,
      status: row.status,
    }
    return {
      full_body,
      artifact_paths: JSON.parse(row.artifact_paths) as string[],
      meta,
    }
  })
}
