/**
 * Per-team domain data DB (~/.openhive/companies/{c}/teams/{t}/data.db).
 * Ports apps/server/openhive/persistence/team_data.py.
 *
 * This DB is SEPARATE from the engine system DB:
 *   - openhive.db       = engine runtime (shared via lib/server/db.ts)
 *   - data.db (per team) = user domain data, AI-writable, JSON1 hybrid
 *
 * Runtime DDL is allowed here (CREATE TABLE / ALTER TABLE). Every schema-
 * changing statement is logged in `schema_migrations` for traceability.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { packagesRoot, teamDir } from './paths'

const BOOTSTRAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  sql         TEXT NOT NULL,
  note        TEXT
);
`

export function teamDbPath(companySlug: string, teamSlug: string): string {
  // Honor OPENHIVE_DATA_DIR env directly so tests that swap tmp dirs per-test
  // don't get pinned to the cached getSettings() value.
  const envRoot = process.env.OPENHIVE_DATA_DIR
  const dir = envRoot
    ? path.join(envRoot, 'companies', companySlug, 'teams', teamSlug)
    : teamDir(companySlug, teamSlug)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'data.db')
}

/**
 * Open/close per call — team data DBs can be numerous and mostly idle. Still
 * cheap enough that we don't bother pooling. Callers should use short-lived
 * handles and avoid crossing request boundaries.
 */
function openTeamDb(companySlug: string, teamSlug: string): BetterSqliteDatabase {
  const file = teamDbPath(companySlug, teamSlug)
  const conn = new Database(file)
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  const busyMs = Number.parseInt(process.env.OPENHIVE_DB_BUSY_TIMEOUT_MS ?? '5000', 10)
  conn.pragma(`busy_timeout = ${Number.isFinite(busyMs) && busyMs > 0 ? busyMs : 5000}`)
  conn.exec(BOOTSTRAP_SCHEMA)
  return conn
}

export function withTeamDb<T>(
  companySlug: string,
  teamSlug: string,
  fn: (conn: BetterSqliteDatabase) => T,
): T {
  const conn = openTeamDb(companySlug, teamSlug)
  const timeoutMs = Number.parseInt(
    process.env.OPENHIVE_DB_QUERY_TIMEOUT_MS ?? '10000',
    10,
  )
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      ;(conn as unknown as { interrupt?: () => void }).interrupt?.()
    } catch {
      /* ignore — interrupt can race with close */
    }
  }, ms)
  try {
    return fn(conn)
  } catch (exc) {
    if (timedOut) {
      const err = new Error(`timeout: query exceeded ${ms}ms`) as Error & {
        code?: string
      }
      err.code = 'timeout'
      throw err
    }
    throw exc
  } finally {
    clearTimeout(timer)
    conn.close()
  }
}

// -------- introspection --------

export interface ColumnInfo {
  name: string
  type: string
  notnull: boolean
  pk: boolean
}

export interface TableInfo {
  name: string
  columns: ColumnInfo[]
  row_count: number
}

export interface MigrationRow {
  id: number
  applied_at: number
  source: string
  sql: string
  note: string | null
}

export interface SchemaDescription {
  tables: TableInfo[]
  recent_migrations: MigrationRow[]
}

export function describeSchema(
  companySlug: string,
  teamSlug: string,
): SchemaDescription {
  return withTeamDb(companySlug, teamSlug, (conn) => {
    const tableRows = conn
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as { name: string }[]
    const tables: TableInfo[] = []
    for (const r of tableRows) {
      if (r.name === 'schema_migrations') continue
      const rawCols = conn
        .prepare(`PRAGMA table_info(${r.name})`)
        .all() as {
        name: string
        type: string
        notnull: number
        pk: number
      }[]
      const columns: ColumnInfo[] = rawCols.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: !!c.notnull,
        pk: !!c.pk,
      }))
      const countRow = conn
        .prepare(`SELECT COUNT(*) AS n FROM ${r.name}`)
        .get() as { n: number }
      tables.push({ name: r.name, columns, row_count: countRow.n })
    }
    const migrations = conn
      .prepare(
        `SELECT id, applied_at, source, sql, note FROM schema_migrations
          ORDER BY id DESC LIMIT 10`,
      )
      .all() as MigrationRow[]
    return { tables, recent_migrations: migrations }
  })
}

// -------- query / exec --------

const SELECT_RE = /^\s*(SELECT|WITH)\b/i
const DDL_RE = /^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/i

/**
 * Return true if `sql` contains more than one statement. We strip line and
 * block comments, then check whether any non-whitespace character appears
 * after the first top-level semicolon (ignoring semicolons inside string
 * literals).
 */
/** Strip SQL line and block comments; return the remaining text. */
export function stripSqlComments(sql: string): string {
  let out = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (!inSingle && !inDouble) {
      if (c === '-' && next === '-') {
        while (i < sql.length && sql[i] !== '\n') i++
        continue
      }
      if (c === '/' && next === '*') {
        i += 2
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
        i += 2
        continue
      }
    }
    if (!inDouble && c === "'") inSingle = !inSingle
    else if (!inSingle && c === '"') inDouble = !inDouble
    out += c
    i++
  }
  return out
}

/**
 * A statement is "destructive" if it can delete wide swathes of data without
 * explicit restriction. The LLM must pass `confirm_destructive: true` at the
 * tool layer before we run these.
 */
export function isDestructiveSql(sql: string): boolean {
  const stripped = stripSqlComments(sql).trim()
  if (/^\s*DROP\s+TABLE\b/i.test(stripped)) return true
  if (/^\s*DROP\s+INDEX\b/i.test(stripped)) return true
  if (/^\s*TRUNCATE\b/i.test(stripped)) return true
  if (/^\s*DELETE\s+FROM\b/i.test(stripped) && !/\bWHERE\b/i.test(stripped)) return true
  if (/^\s*UPDATE\b/i.test(stripped) && !/\bWHERE\b/i.test(stripped)) return true
  return false
}

export function hasMultipleStatements(sql: string): boolean {
  let i = 0
  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let inBlockComment = false
  let sawStatementEnd = false
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (inLineComment) {
      if (c === '\n') inLineComment = false
      i++
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inSingle) {
      if (c === "'") inSingle = false
      i++
      continue
    }
    if (inDouble) {
      if (c === '"') inDouble = false
      i++
      continue
    }
    if (c === '-' && next === '-') {
      inLineComment = true
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }
    if (c === "'") {
      inSingle = true
      i++
      continue
    }
    if (c === '"') {
      inDouble = true
      i++
      continue
    }
    if (c === ';') {
      sawStatementEnd = true
      i++
      continue
    }
    if (sawStatementEnd && c !== undefined && !/\s/.test(c)) {
      return true
    }
    i++
  }
  return false
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

export type SqlParam = string | number | bigint | null | Uint8Array

export interface RunQueryOptions {
  params?: SqlParam[]
}

export function runQuery(
  companySlug: string,
  teamSlug: string,
  sql: string,
  opts: RunQueryOptions = {},
): QueryResult {
  if (hasMultipleStatements(sql)) {
    const err = new Error('multi_statement: only one SQL statement per call')
    ;(err as Error & { code?: string }).code = 'multi_statement'
    throw err
  }
  if (!SELECT_RE.test(sql)) {
    throw new Error('run_query accepts only SELECT/WITH statements')
  }
  return withTeamDb(companySlug, teamSlug, (conn) => {
    const stmt = conn.prepare(sql)
    let columns: string[] = []
    try {
      columns = stmt.columns().map((c) => c.name)
    } catch {
      /* not a SELECT with columns */
    }
    const rows = (opts.params && opts.params.length > 0
      ? stmt.all(...opts.params)
      : stmt.all()) as Record<string, unknown>[]
    if (columns.length === 0 && rows.length > 0) {
      columns = Object.keys(rows[0] ?? {})
    }
    return { columns, rows }
  })
}

export interface ExecResult {
  ok: true
  rows_changed: number
  ddl: boolean
}

export interface RunExecOptions {
  source?: string
  note?: string | null
  params?: SqlParam[]
}

export function runExec(
  companySlug: string,
  teamSlug: string,
  sql: string,
  opts: RunExecOptions = {},
): ExecResult {
  if (hasMultipleStatements(sql)) {
    const err = new Error('multi_statement: only one SQL statement per call')
    ;(err as Error & { code?: string }).code = 'multi_statement'
    throw err
  }
  const isDdl = DDL_RE.test(sql)
  const source = opts.source ?? 'ai'
  const note = opts.note ?? null
  return withTeamDb(companySlug, teamSlug, (conn) => {
    const tx = conn.transaction(() => {
      const stmt = conn.prepare(sql)
      const info = opts.params && opts.params.length > 0
        ? stmt.run(...opts.params)
        : stmt.run()
      if (isDdl) {
        conn
          .prepare(
            `INSERT INTO schema_migrations (applied_at, source, sql, note)
             VALUES (?, ?, ?, ?)`,
          )
          .run(Date.now(), source, sql, note)
      }
      return info.changes
    })
    const rowsChanged = tx()
    return { ok: true, rows_changed: rowsChanged, ddl: isDdl }
  })
}

// -------- template install --------

function templatesRoot(): string {
  return path.join(packagesRoot(), 'templates')
}

export interface InstallTemplateResult {
  ok: true
  template: string
}

export function installTemplate(
  companySlug: string,
  teamSlug: string,
  templateName: string,
): InstallTemplateResult {
  const file = path.join(templatesRoot(), templateName, 'install.sql')
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const err = new Error(`template not found: ${file}`)
    ;(err as Error & { code?: string }).code = 'ENOENT'
    throw err
  }
  const script = fs.readFileSync(file, 'utf8')
  return withTeamDb(companySlug, teamSlug, (conn) => {
    const tx = conn.transaction(() => {
      conn.exec(script)
      conn
        .prepare(
          `INSERT INTO schema_migrations (applied_at, source, sql, note)
           VALUES (?, ?, ?, ?)`,
        )
        .run(Date.now(), `template:${templateName}`, script, null)
    })
    tx()
    return { ok: true, template: templateName }
  })
}
