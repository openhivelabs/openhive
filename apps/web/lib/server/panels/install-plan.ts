/**
 * Install-time schema router — mirrors the playbook in
 * `packages/skills/db/reference/install-routing.md`. Given the company's
 * current schema + an incoming panel frame, emits a plan:
 *
 *   - `reuse`      → panel rides on an existing table as-is
 *   - `extend`     → ALTER existing table(s) with new columns / FKs
 *   - `standalone` → run the frame's own setup.sql untouched
 *
 * Deterministic + fast: no external LLM call in this path. The skill
 * references are the human-readable spec; this file is the enforcement.
 * A real-AI fallback can replace `decide()` later without changing the
 * public shape.
 */

import { describeSchema, type TableInfo } from '../team-data'

type InstallDecision = 'reuse' | 'extend' | 'standalone'

interface InstallPlan {
  decision: InstallDecision
  brief: string
  target_table: string | null
  alter_sql: string[]
  skip_create_tables: string[]
  rewrite_panel_sql: string | null
  confidence: number
  ai_called: boolean
}

interface PlanInput {
  companySlug: string
  teamId: string
  /** Raw DDL the incoming frame would run in its "blank" form. May be
   *  empty / undefined when the panel only queries existing tables. */
  setupSql: string | undefined
  /** The panel's own SELECT — used to detect which tables the panel
   *  actually reads, independent of what setupSql creates. */
  panelSql: string | undefined
}

export function buildInstallPlan(input: PlanInput): InstallPlan {
  const schema = describeSchema(input.companySlug)
  const existingTables = new Map(schema.tables.map((t) => [t.name, t]))
  const incoming = parseSetupSql(input.setupSql ?? '')

  // Shortcut: panel has no setup_sql at all — it only reads existing
  // tables. Nothing to install, nothing to decide. Standalone w/ 1.0 conf.
  if (incoming.length === 0) {
    return standalone('별도 DDL 없이 기존 테이블에서 읽어옵니다.', 1.0, false)
  }

  // Shortcut: empty DB. Always standalone — nothing to compare against.
  if (existingTables.size === 0) {
    return standalone('빈 데이터베이스 — 새 테이블을 바로 만듭니다.', 1.0, false)
  }

  // Pick the "primary" incoming table — the one the panel reads from.
  // Falls back to the first created table if the panel SQL is empty or
  // references a symbol we don't recognize.
  const panelTables = extractTablesFromSelect(input.panelSql ?? '')
  const primary =
    incoming.find((t) => panelTables.has(t.name)) ?? incoming[0] ?? null
  if (!primary) {
    return standalone(
      'setup_sql 해석 실패 — 원본 DDL 그대로 실행합니다.',
      0.6,
      false,
    )
  }

  const existing = existingTables.get(primary.name)

  // ── Case: primary table already exists ───────────────────────────────
  if (existing) {
    const missing = missingColumns(primary, existing)

    // Pure reuse — every incoming column is already on the existing
    // table. Skip the CREATE entirely.
    if (missing.length === 0) {
      return {
        decision: 'reuse',
        brief: `기존 ${primary.name} 테이블을 그대로 사용합니다.`,
        target_table: primary.name,
        alter_sql: [],
        skip_create_tables: [primary.name],
        rewrite_panel_sql: null,
        confidence: 0.95,
        ai_called: false,
      }
    }

    // Some columns are missing — extend via ALTER. Safe only when the
    // missing columns have defaults or are nullable; otherwise we can't
    // add them to a table with existing rows.
    const unsafe = missing.filter((c) => !c.nullable && !c.hasDefault)
    if (unsafe.length > 0 && existing.row_count > 0) {
      // Can't safely extend a non-empty table with NOT NULL / no-default
      // columns. Fall through to standalone so the frame's own setup
      // runs idempotently (IF NOT EXISTS just no-ops on the existing
      // table; the user-facing SELECT may then be incomplete, but the
      // install won't destroy data).
      return standalone(
        `기존 ${primary.name}에 새 컬럼을 안전하게 추가할 수 없어 원본 DDL을 유지합니다.`,
        0.5,
        false,
      )
    }

    const alter = missing.map((c) => {
      // SQLite rejects ALTER TABLE ADD COLUMN with non-constant DEFAULT
      // expressions (function calls, parentheses, subqueries). The CREATE
      // TABLE form accepts them, so we keep defaults there. For ALTER we
      // drop any non-constant default — the column becomes NULL for
      // existing rows and future inserts populate it via panel actions.
      const safeDefault = isConstantDefault(c.defaultExpr)
        ? ` DEFAULT ${c.defaultExpr}`
        : ''
      return `ALTER TABLE ${primary.name} ADD COLUMN ${c.name} ${c.type}${safeDefault}`
    })
    return {
      decision: 'extend',
      brief: `기존 ${primary.name} 테이블에 ${missing.length}개 컬럼을 추가합니다.`,
      target_table: primary.name,
      alter_sql: alter,
      skip_create_tables: [primary.name],
      rewrite_panel_sql: null,
      confidence: 0.85,
      ai_called: false,
    }
  }

  // ── Case: primary table doesn't exist → would be brand-new. ─────────
  // Check whether it has FK-shaped columns pointing at any existing
  // table (e.g. `deal.customer_id` when `customer` is present). If so,
  // say so in the brief — the relationship is carried by the CREATE
  // itself, no ALTER needed.
  const fkLinks = findForeignKeyCandidates(primary, existingTables)
  if (fkLinks.length > 0) {
    const parents = fkLinks.map((f) => f.parentTable).join(', ')
    return {
      decision: 'standalone',
      brief: `새 ${primary.name} 테이블을 만들고 ${parents}와 연결합니다.`,
      target_table: null,
      alter_sql: [],
      skip_create_tables: [],
      rewrite_panel_sql: null,
      confidence: 0.9,
      ai_called: false,
    }
  }

  // No relation detectable — pure standalone.
  return standalone(`기존 데이터와 무관한 새 ${primary.name} 테이블을 만듭니다.`, 0.95, false)
}

function standalone(brief: string, confidence: number, aiCalled: boolean): InstallPlan {
  return {
    decision: 'standalone',
    brief,
    target_table: null,
    alter_sql: [],
    skip_create_tables: [],
    rewrite_panel_sql: null,
    confidence,
    ai_called: aiCalled,
  }
}

// ---------- parsers ----------

interface ParsedTable {
  name: string
  columns: ParsedColumn[]
}

interface ParsedColumn {
  name: string
  type: string
  nullable: boolean
  hasDefault: boolean
  defaultExpr: string | null
}

/** Parse every `CREATE TABLE ... (...)` in the SQL blob. Best-effort —
 *  ignores non-CREATE statements, nested parens in column constraints,
 *  and comments. Good enough for the panel-frame seed-DDL shape. */
function parseSetupSql(sql: string): ParsedTable[] {
  if (!sql.trim()) return []
  const stripped = stripComments(sql)
  const out: ParsedTable[] = []
  const re =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(([\s\S]*?)\)\s*(?:;|$)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1]!
    const body = m[2]!
    out.push({ name, columns: parseColumnList(body) })
  }
  return out
}

function parseColumnList(body: string): ParsedColumn[] {
  const out: ParsedColumn[] = []
  // Split by commas at top level (don't split inside parens).
  const parts: string[] = []
  let buf = ''
  let depth = 0
  for (const c of body) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  if (buf.trim()) parts.push(buf)

  for (const raw of parts) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const upper = trimmed.toUpperCase()
    // Skip table-level constraints (PRIMARY KEY (...), UNIQUE (...), etc.)
    if (
      upper.startsWith('PRIMARY KEY') ||
      upper.startsWith('UNIQUE') ||
      upper.startsWith('CHECK') ||
      upper.startsWith('FOREIGN KEY') ||
      upper.startsWith('CONSTRAINT')
    ) {
      continue
    }
    const tokens = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/)
    if (!tokens) continue
    const colName = tokens[1]!
    const rest = tokens[2]!
    const typeMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?)/)
    const type = typeMatch ? typeMatch[1]! : 'TEXT'
    const restUpper = rest.toUpperCase()
    const nullable = !/\bNOT\s+NULL\b/.test(restUpper)
    const defaultMatch = rest.match(/\bDEFAULT\s+(.+?)(?:\s+(?:NOT\s+)?NULL|\s*$|,)/i)
    const defaultExpr = defaultMatch ? defaultMatch[1]!.trim() : null
    out.push({
      name: colName,
      type: type.toUpperCase(),
      nullable,
      hasDefault: defaultExpr !== null,
      defaultExpr,
    })
  }
  return out
}

function stripComments(sql: string): string {
  // Line comments
  let out = sql.replace(/--[^\n]*/g, '')
  // Block comments
  out = out.replace(/\/\*[\s\S]*?\*\//g, '')
  return out
}

/** Extract table names referenced in a SELECT via FROM / JOIN. Best-effort;
 *  misses CTEs but that's fine for our seed SQL. */
function extractTablesFromSelect(sql: string): Set<string> {
  const out = new Set<string>()
  if (!sql.trim()) return out
  const stripped = stripComments(sql)
  const re = /\b(?:FROM|JOIN)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    out.add(m[1]!)
  }
  return out
}

// ---------- comparison helpers ----------

/** True when `expr` is a SQLite-constant value: NULL, a numeric literal, a
 *  string literal, or a bare keyword like CURRENT_TIMESTAMP. Function-call
 *  defaults (e.g. `(datetime('now'))`) are rejected by `ALTER TABLE ADD
 *  COLUMN` even though they're legal in `CREATE TABLE`. */
function isConstantDefault(expr: string | null | undefined): boolean {
  if (!expr) return false
  const s = expr.trim()
  if (!s) return false
  if (/^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(s))
    return true
  // Numeric literal (int / float / negative / scientific)
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) return true
  // Single-quoted string literal (no embedded unescaped quotes)
  if (/^'(?:''|[^'])*'$/.test(s)) return true
  // Parenthesized constant (`(0)`, `(-1)`) — unwrap one level.
  const paren = s.match(/^\((.+)\)$/)
  if (paren) return isConstantDefault(paren[1]!)
  return false
}

function missingColumns(incoming: ParsedTable, existing: TableInfo): ParsedColumn[] {
  const have = new Set(existing.columns.map((c) => c.name))
  return incoming.columns.filter((c) => !have.has(c.name))
}

interface FkCandidate {
  column: string
  parentTable: string
}

/** Detect columns of the form `<table>_id` that point at an existing
 *  table of that name. Ignores core id columns. */
function findForeignKeyCandidates(
  incoming: ParsedTable,
  existing: Map<string, TableInfo>,
): FkCandidate[] {
  const out: FkCandidate[] = []
  for (const col of incoming.columns) {
    const m = col.name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)_id$/)
    if (!m) continue
    const parent = m[1]!
    if (parent === 'team') continue // `team_id` is the namespace, not an FK
    if (existing.has(parent)) {
      out.push({ column: col.name, parentTable: parent })
    }
  }
  return out
}
