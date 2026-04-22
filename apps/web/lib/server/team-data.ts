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
  const dir = teamDir(companySlug, teamSlug)
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
  // Bootstrap is idempotent — cheap to run every open.
  conn.exec(BOOTSTRAP_SCHEMA)
  return conn
}

export function withTeamDb<T>(
  companySlug: string,
  teamSlug: string,
  fn: (conn: BetterSqliteDatabase) => T,
): T {
  const conn = openTeamDb(companySlug, teamSlug)
  try {
    return fn(conn)
  } finally {
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

/**
 * Describe a single table with schema + row count + up to N sample rows.
 * Used by the AI composer so the model can write SQL against a real shape
 * instead of guessing. Samples are always limited and never include `deleted_at`-
 * marked rows (when that convention is present) so they stay representative.
 */
export function describeTable(
  companySlug: string,
  teamSlug: string,
  tableName: string,
  sampleLimit = 3,
): TableInfo & { samples: Record<string, unknown>[] } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid table name: ${JSON.stringify(tableName)}`)
  }
  return withTeamDb(companySlug, teamSlug, (conn) => {
    const rawCols = conn.prepare(`PRAGMA table_info(${tableName})`).all() as {
      name: string
      type: string
      notnull: number
      pk: number
    }[]
    if (rawCols.length === 0) {
      throw new Error(`table not found: ${tableName}`)
    }
    const columns: ColumnInfo[] = rawCols.map((c) => ({
      name: c.name,
      type: c.type,
      notnull: !!c.notnull,
      pk: !!c.pk,
    }))
    const countRow = conn.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number }
    const hasSoftDelete = rawCols.some((c) => c.name === 'deleted_at')
    const where = hasSoftDelete ? 'WHERE deleted_at IS NULL' : ''
    const samples = conn
      .prepare(`SELECT * FROM ${tableName} ${where} LIMIT ?`)
      .all(Math.max(1, Math.min(10, sampleLimit))) as Record<string, unknown>[]
    return {
      name: tableName,
      columns,
      row_count: countRow.n,
      samples,
    }
  })
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

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

export function runQuery(
  companySlug: string,
  teamSlug: string,
  sql: string,
): QueryResult {
  if (!SELECT_RE.test(sql)) {
    throw new Error('run_query accepts only SELECT/WITH statements')
  }
  return withTeamDb(companySlug, teamSlug, (conn) => {
    const stmt = conn.prepare(sql)
    // better-sqlite3 infers column names via .columns() only for prepared
    // SELECT statements. Fall back to keys of first row if empty.
    let columns: string[] = []
    try {
      columns = stmt.columns().map((c) => c.name)
    } catch {
      /* not a SELECT with columns — fallthrough */
    }
    const rows = stmt.all() as Record<string, unknown>[]
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

export function runExec(
  companySlug: string,
  teamSlug: string,
  sql: string,
  opts: { source?: string; note?: string | null } = {},
): ExecResult {
  const isDdl = DDL_RE.test(sql)
  const source = opts.source ?? 'ai'
  const note = opts.note ?? null
  return withTeamDb(companySlug, teamSlug, (conn) => {
    const tx = conn.transaction(() => {
      const info = conn.prepare(sql).run()
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
