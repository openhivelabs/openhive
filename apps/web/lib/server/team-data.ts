/**
 * Company-scoped domain data DB (~/.openhive/companies/{c}/data.db).
 *
 * Every user-created table carries a `team_id` column as the soft namespace.
 * Panel SQL binds `:team_id` at execution time so each team sees only its
 * own rows; panels that intentionally omit the filter act as cross-team
 * views.
 *
 * This DB is SEPARATE from the engine system DB:
 *   - openhive.db               = engine runtime (shared via lib/server/db.ts)
 *   - companies/<c>/data.db     = user domain data, AI-writable, JSON1 hybrid
 *
 * Runtime DDL is allowed here (CREATE TABLE / ALTER TABLE). Every schema-
 * changing statement is logged in `schema_migrations` for traceability; the
 * log carries the `team_id` responsible for the change (NULL = company-wide).
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { companyDir, packagesRoot, teamDir } from './paths'

const BOOTSTRAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  sql         TEXT NOT NULL,
  note        TEXT,
  team_id     TEXT
);
`

export function companyDbPath(companySlug: string): string {
  // Honor OPENHIVE_DATA_DIR env directly so tests that swap tmp dirs per-test
  // don't get pinned to the cached getSettings() value.
  const envRoot = process.env.OPENHIVE_DATA_DIR
  const dir = envRoot ? path.join(envRoot, 'companies', companySlug) : companyDir(companySlug)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'data.db')
}

/**
 * @deprecated Kept only for the one-shot team→company DB migration. Runtime
 * code must use {@link companyDbPath}.
 */
function teamDbPath(companySlug: string, teamSlug: string): string {
  const envRoot = process.env.OPENHIVE_DATA_DIR
  const dir = envRoot
    ? path.join(envRoot, 'companies', companySlug, 'teams', teamSlug)
    : teamDir(companySlug, teamSlug)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'data.db')
}

/**
 * Per-process company DB connection pool. Keeping a single Database handle
 * per file (a) skips the WAL header read + journal-mode pragma round trip
 * on every panel request, (b) lets prepared statement caches inside
 * better-sqlite3 stay warm, and (c) avoids repeated re-execution of the
 * idempotent BOOTSTRAP_SCHEMA. Stored on globalThis so HMR / tsx watch
 * don't multiply opened handles.
 */
const COMPANY_DB_POOL_KEY = Symbol.for('openhive.company.db.pool')
type CompanyPool = Map<string, BetterSqliteDatabase>
function companyDbPool(): CompanyPool {
  const g = globalThis as unknown as { [COMPANY_DB_POOL_KEY]?: CompanyPool }
  if (!g[COMPANY_DB_POOL_KEY]) {
    g[COMPANY_DB_POOL_KEY] = new Map()
    // One-time process exit hook to flush WAL + close handles. `unref` keeps
    // the listener from holding the loop open on its own.
    const close = () => {
      for (const conn of g[COMPANY_DB_POOL_KEY]?.values() ?? []) {
        try {
          conn.close()
        } catch {
          /* ignore */
        }
      }
      g[COMPANY_DB_POOL_KEY]?.clear()
    }
    process.once('beforeExit', close)
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  }
  return g[COMPANY_DB_POOL_KEY] as CompanyPool
}

function openCompanyDb(companySlug: string): BetterSqliteDatabase {
  const file = companyDbPath(companySlug)
  const pool = companyDbPool()
  const cached = pool.get(file)
  if (cached) {
    // `Database#open` is true while the handle is usable. A handle could
    // theoretically be closed externally (tests); fall through to re-open.
    if ((cached as unknown as { open?: boolean }).open !== false) return cached
    pool.delete(file)
  }
  const conn = new Database(file)
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  const busyMs = Number.parseInt(process.env.OPENHIVE_DB_BUSY_TIMEOUT_MS ?? '5000', 10)
  conn.pragma(`busy_timeout = ${Number.isFinite(busyMs) && busyMs > 0 ? busyMs : 5000}`)
  conn.exec(BOOTSTRAP_SCHEMA)
  // Forward-compat: ensure the team_id column exists on pre-existing
  // schema_migrations tables that were bootstrapped before this column was
  // added. SQLite ignores ADD COLUMN IF NOT EXISTS, so emulate.
  try {
    const cols = conn.prepare('PRAGMA table_info(schema_migrations)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'team_id')) {
      conn.exec('ALTER TABLE schema_migrations ADD COLUMN team_id TEXT')
    }
  } catch {
    /* ignore — migration will log if something is genuinely wrong */
  }
  pool.set(file, conn)
  return conn
}

/** Test helper: drop the pool so OPENHIVE_DATA_DIR rotations between cases
 *  re-open against the new directory. */
function __resetCompanyDbPoolForTests(): void {
  const g = globalThis as unknown as { [COMPANY_DB_POOL_KEY]?: CompanyPool }
  for (const conn of g[COMPANY_DB_POOL_KEY]?.values() ?? []) {
    try {
      conn.close()
    } catch {
      /* ignore */
    }
  }
  g[COMPANY_DB_POOL_KEY]?.clear()
}

export function withCompanyDb<T>(companySlug: string, fn: (conn: BetterSqliteDatabase) => T): T {
  const conn = openCompanyDb(companySlug)
  const timeoutMs = Number.parseInt(process.env.OPENHIVE_DB_QUERY_TIMEOUT_MS ?? '10000', 10)
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
    // Pooled connection — leave it open. `process.beforeExit` closes them.
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

interface MigrationRow {
  id: number
  applied_at: number
  source: string
  sql: string
  note: string | null
  team_id: string | null
}

interface SchemaDescription {
  tables: TableInfo[]
  recent_migrations: MigrationRow[]
}

/**
 * Describe a single table with schema + row count + up to N sample rows.
 * Used by the AI composer so the model can write SQL against a real shape
 * instead of guessing. When `teamId` is passed, samples + row_count are
 * scoped to that team (so the AI doesn't leak rows from peer teams into
 * its few-shot examples). Without `teamId`, returns the company-wide view.
 */
function describeTable(
  companySlug: string,
  tableName: string,
  opts: { teamId?: string; sampleLimit?: number } = {},
): TableInfo & { samples: Record<string, unknown>[] } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid table name: ${JSON.stringify(tableName)}`)
  }
  const sampleLimit = opts.sampleLimit ?? 3
  return withCompanyDb(companySlug, (conn) => {
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
    const hasTeamIdCol = rawCols.some((c) => c.name === 'team_id')
    const hasSoftDelete = rawCols.some((c) => c.name === 'deleted_at')
    const whereParts: string[] = []
    if (hasSoftDelete) whereParts.push('deleted_at IS NULL')
    if (hasTeamIdCol && opts.teamId) whereParts.push('team_id = :team_id')
    const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''
    const binds: Record<string, unknown> = {}
    if (hasTeamIdCol && opts.teamId) binds.team_id = opts.teamId
    const countStmt = conn.prepare(`SELECT COUNT(*) AS n FROM ${tableName} ${where}`)
    const countRow = (Object.keys(binds).length > 0 ? countStmt.get(binds) : countStmt.get()) as {
      n: number
    }
    const sampleStmt = conn.prepare(`SELECT * FROM ${tableName} ${where} LIMIT :__limit`)
    const samples = sampleStmt.all({
      ...binds,
      __limit: Math.max(1, Math.min(10, sampleLimit)),
    }) as Record<string, unknown>[]
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
  opts: { teamId?: string } = {},
): SchemaDescription {
  return withCompanyDb(companySlug, (conn) => {
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
      const rawCols = conn.prepare(`PRAGMA table_info(${r.name})`).all() as {
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
      const hasTeamIdCol = rawCols.some((c) => c.name === 'team_id')
      const countStmt =
        hasTeamIdCol && opts.teamId
          ? conn.prepare(`SELECT COUNT(*) AS n FROM ${r.name} WHERE team_id = :team_id`)
          : conn.prepare(`SELECT COUNT(*) AS n FROM ${r.name}`)
      const countRow = (
        hasTeamIdCol && opts.teamId ? countStmt.get({ team_id: opts.teamId }) : countStmt.get()
      ) as { n: number }
      tables.push({ name: r.name, columns, row_count: countRow.n })
    }
    const migrationStmt = opts.teamId
      ? conn.prepare(
          `SELECT id, applied_at, source, sql, note, team_id
               FROM schema_migrations
              WHERE team_id = :team_id OR team_id IS NULL
              ORDER BY id DESC LIMIT 10`,
        )
      : conn.prepare(
          `SELECT id, applied_at, source, sql, note, team_id
               FROM schema_migrations
              ORDER BY id DESC LIMIT 10`,
        )
    const migrations = (
      opts.teamId ? migrationStmt.all({ team_id: opts.teamId }) : migrationStmt.all()
    ) as MigrationRow[]
    return { tables, recent_migrations: migrations }
  })
}

/** Schema-only column info for a single team_data table — used by the
 *  synthesized-action layer to derive create/update form fields without
 *  re-running a full describeSchema across every table. Returns [] when
 *  the table is missing or the company DB can't be opened. */
export function getTableColumns(companySlug: string, tableName: string): ColumnInfo[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return []
  try {
    return withCompanyDb(companySlug, (conn) => {
      const rows = conn.prepare(`PRAGMA table_info(${tableName})`).all() as {
        name: string
        type: string
        notnull: number
        pk: number
        dflt_value: unknown
      }[]
      return rows.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: !!c.notnull,
        pk: !!c.pk,
      }))
    })
  } catch {
    return []
  }
}

/** Pull the original CREATE TABLE statement for a team_data table. SQLite
 *  stores the raw DDL alongside each row in sqlite_master, which is the
 *  only place the CHECK constraint survives untouched (PRAGMA collapses
 *  it). Returns null when the table doesn't exist or the company DB is
 *  missing — caller treats either as "no extra metadata available". */
export function getTableCreateSql(companySlug: string, tableName: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return null
  try {
    return withCompanyDb(companySlug, (conn) => {
      const row = conn
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = :name`)
        .get({ name: tableName }) as { sql?: string } | undefined
      return typeof row?.sql === 'string' ? row.sql : null
    })
  } catch {
    return null
  }
}

/** Parse `CHECK (col IN ('a','b','c'))` from a CREATE TABLE statement.
 *  The renderer uses this for kanban stage taxonomy: live DB schema is
 *  the source of truth, and bindings can omit the duplicate copy.
 *  Returns [] when no matching CHECK is present. */
export function extractCheckOptions(createSql: string, columnName: string): string[] {
  if (!columnName) return []
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`CHECK\\s*\\(\\s*["\`]?${escaped}["\`]?\\s+IN\\s*\\(([^)]+)\\)\\s*\\)`, 'i')
  const m = re.exec(createSql)
  if (!m || !m[1]) return []
  const out: string[] = []
  for (const tok of m[1].split(',')) {
    const t = tok.trim()
    const sm = /^['"](.*)['"]$/.exec(t)
    if (sm?.[1]) out.push(sm[1])
  }
  return out
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
function stripSqlComments(sql: string): string {
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

interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

export type SqlParam = string | number | bigint | null | Uint8Array

interface RunQueryOptions {
  /** Either a positional array (bound as `?1..?N`) or a named map (`:name`
   *  in SQL). When `teamId` is set alongside a named map, the map is
   *  augmented with `team_id`. Positional arrays don't get auto-binding —
   *  callers that also want team_id must use named params. */
  params?: Record<string, SqlParam> | SqlParam[]
  /** When set, bound as `:team_id` in the query — convention for panel SQL
   *  that scopes reads to a single team. */
  teamId?: string
}

type PreparedBinds =
  | { kind: 'positional'; values: SqlParam[] }
  | { kind: 'named'; values: Record<string, SqlParam> }
  | null

function mergeBinds(opts: {
  params?: Record<string, SqlParam> | SqlParam[]
  teamId?: string
}): PreparedBinds {
  if (Array.isArray(opts.params)) {
    return opts.params.length > 0 ? { kind: 'positional', values: opts.params } : null
  }
  const out: Record<string, SqlParam> = { ...(opts.params ?? {}) }
  if (opts.teamId !== undefined) out.team_id = opts.teamId
  return Object.keys(out).length > 0 ? { kind: 'named', values: out } : null
}

function applyBinds<T>(
  run: (args?: SqlParam[] | Record<string, SqlParam>) => T,
  binds: PreparedBinds,
): T {
  if (!binds) return run()
  if (binds.kind === 'positional') return run(binds.values)
  return run(binds.values)
}

/** Apply DDL (CREATE TABLE …) inside a SAVEPOINT, run the SELECT against
 *  the resulting in-transaction schema, then ROLLBACK so the live DB is
 *  left untouched. Used by the install-preview path to render a panel
 *  preview against an AI-generated table without committing it. */
export function dryRunWithSetup(
  companySlug: string,
  setupStatements: string[],
  selectSql: string,
  opts: RunQueryOptions = {},
): QueryResult {
  if (hasMultipleStatements(selectSql)) {
    const err = new Error('multi_statement: only one SQL statement per call')
    ;(err as Error & { code?: string }).code = 'multi_statement'
    throw err
  }
  if (!SELECT_RE.test(selectSql)) {
    throw new Error('dry_run accepts only SELECT/WITH statements')
  }
  return withCompanyDb(companySlug, (conn) => {
    conn.exec('SAVEPOINT panel_dry_run')
    try {
      for (const stmt of setupStatements) {
        if (!stmt.trim()) continue
        if (hasMultipleStatements(stmt)) {
          throw new Error('setup contained multi-statement SQL')
        }
        if (!DDL_RE.test(stmt)) {
          throw new Error('setup must be DDL (CREATE TABLE / ALTER / …)')
        }
        conn.prepare(stmt).run()
      }
      const sel = conn.prepare(selectSql)
      let columns: string[] = []
      try {
        columns = sel.columns().map((c) => c.name)
      } catch {
        /* not a SELECT with named columns */
      }
      const binds = mergeBinds(opts)
      const rows = applyBinds(
        (args) =>
          (args === undefined
            ? sel.all()
            : Array.isArray(args)
              ? sel.all(...args)
              : sel.all(args)) as Record<string, unknown>[],
        binds,
      )
      if (columns.length === 0 && rows.length > 0) {
        columns = Object.keys(rows[0] ?? {})
      }
      return { columns, rows }
    } finally {
      // Always rewind the schema/data changes, even on success — this is
      // a preview, not a commit.
      try {
        conn.exec('ROLLBACK TO SAVEPOINT panel_dry_run')
      } catch {
        /* ignore — savepoint may have been auto-released by an error */
      }
      try {
        conn.exec('RELEASE SAVEPOINT panel_dry_run')
      } catch {
        /* ignore */
      }
    }
  })
}

export function runQuery(
  companySlug: string,
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
  return withCompanyDb(companySlug, (conn) => {
    const stmt = conn.prepare(sql)
    let columns: string[] = []
    try {
      columns = stmt.columns().map((c) => c.name)
    } catch {
      /* not a SELECT with columns */
    }
    const binds = mergeBinds(opts)
    const rows = applyBinds(
      (args) =>
        (args === undefined
          ? stmt.all()
          : Array.isArray(args)
            ? stmt.all(...args)
            : stmt.all(args)) as Record<string, unknown>[],
      binds,
    )
    if (columns.length === 0 && rows.length > 0) {
      columns = Object.keys(rows[0] ?? {})
    }
    return { columns, rows }
  })
}

interface ExecResult {
  ok: true
  rows_changed: number
  ddl: boolean
}

interface RunExecOptions {
  source?: string
  note?: string | null
  params?: Record<string, SqlParam> | SqlParam[]
  /** Recorded into schema_migrations.team_id when DDL runs. Also bound as
   *  `:team_id` if the SQL references it. */
  teamId?: string
}

export function runExec(companySlug: string, sql: string, opts: RunExecOptions = {}): ExecResult {
  if (hasMultipleStatements(sql)) {
    const err = new Error('multi_statement: only one SQL statement per call')
    ;(err as Error & { code?: string }).code = 'multi_statement'
    throw err
  }
  const isDdl = DDL_RE.test(sql)
  const source = opts.source ?? 'ai'
  const note = opts.note ?? null
  const teamId = opts.teamId ?? null
  return withCompanyDb(companySlug, (conn) => {
    const tx = conn.transaction(() => {
      const stmt = conn.prepare(sql)
      const binds = mergeBinds(opts)
      const info = applyBinds(
        (args) =>
          args === undefined
            ? stmt.run()
            : Array.isArray(args)
              ? stmt.run(...args)
              : stmt.run(args),
        binds,
      )
      if (isDdl) {
        conn
          .prepare(
            `INSERT INTO schema_migrations (applied_at, source, sql, note, team_id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(Date.now(), source, sql, note, teamId)
      }
      return info.changes
    })
    const rowsChanged = tx()
    return { ok: true, rows_changed: rowsChanged, ddl: isDdl }
  })
}

// -------- template install --------

function templatesRoot(): string {
  return process.env.OPENHIVE_TEMPLATES_DIR ?? path.join(packagesRoot(), 'templates')
}

interface InstallTemplateResult {
  ok: true
  template: string
  tables_created: string[]
}

export function installTemplate(
  companySlug: string,
  templateName: string,
  opts: { teamId?: string | null } = {},
): InstallTemplateResult {
  const file = path.join(templatesRoot(), templateName, 'install.sql')
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const err = new Error(`template not found: ${file}`)
    ;(err as Error & { code?: string }).code = 'ENOENT'
    throw err
  }
  const script = fs.readFileSync(file, 'utf8')
  return withCompanyDb(companySlug, (conn) => {
    const listTables = (): Set<string> =>
      new Set(
        (
          conn
            .prepare(
              `SELECT name FROM sqlite_master
                WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
            )
            .all() as { name: string }[]
        ).map((r) => r.name),
      )
    const before = listTables()
    const tx = conn.transaction(() => {
      conn.exec(script)
      conn
        .prepare(
          `INSERT INTO schema_migrations (applied_at, source, sql, note, team_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(Date.now(), `template:${templateName}`, script, null, opts.teamId ?? null)
    })
    tx()
    const after = listTables()
    const created: string[] = []
    for (const t of after) {
      if (!before.has(t) && t !== 'schema_migrations') created.push(t)
    }
    return { ok: true, template: templateName, tables_created: created.sort() }
  })
}
