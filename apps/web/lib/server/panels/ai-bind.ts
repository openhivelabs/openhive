import type { PanelBinding } from '@/lib/api/dashboards'
import { listServers } from '@/lib/server/mcp/config'
import { callTool, getTools } from '@/lib/server/mcp/manager'
import { chatCompletion } from '@/lib/server/providers/copilot'
import { extractCheckOptions } from '@/lib/server/team-data'
import type { describeSchema } from '@/lib/server/team-data'
import { buildSystemPrompt } from './ai-prompt'

type Schema = ReturnType<typeof describeSchema>

interface AiBindInput {
  panel: Record<string, unknown>
  description?: string
  schema: Schema
  userIntent: string | null
}

export interface AiBindResult {
  binding: PanelBinding
  /** Optional CREATE TABLE statement the binder produced when the user
   *  explicitly asked for a new table. Install path runs this idempotently
   *  before applying the binding. */
  setupSql?: string
}

export async function aiBindPanel({
  panel,
  description,
  schema,
  userIntent,
}: AiBindInput): Promise<AiBindResult> {
  const tdLines = (schema.tables ?? []).map(
    (t) =>
      `  - ${t.name}(${t.columns.map((col) => `${col.name}:${col.type ?? ''}`).join(', ')})`,
  )

  // Send each tool's name + description + input schema. Without the schema
  // the AI guesses argument names (e.g. `project` instead of `project_id`)
  // and the call returns empty / errors. Cap at 20 tools per server so the
  // prompt doesn't explode on servers exposing 100+ tools.
  //
  // ALSO eagerly call each server's discovery tools (list_*/search_* with no
  // required args) so the AI sees concrete name→ID pairs in its prompt. This
  // is the only way one-shot binding can resolve "curio" → UUID without a
  // round-trip — otherwise the AI just stops at list_projects and the user
  // has to follow up. Capped to 3 discovery tools per server, 5s budget.
  const mcpLines: string[] = []
  const idLines: string[] = []
  const schemaLines: string[] = []
  for (const name of Object.keys(listServers())) {
    try {
      const tools = await getTools(name)
      if (tools.length === 0) {
        mcpLines.push(`  ${name}: (no tools)`)
        continue
      }
      mcpLines.push(`  ${name}:`)
      for (const t of tools.slice(0, 20)) {
        const desc = (t.description ?? '').replace(/\s+/g, ' ').slice(0, 200)
        const schema = JSON.stringify(t.inputSchema ?? {}).slice(0, 600)
        mcpLines.push(`    - ${t.name}: ${desc}`)
        mcpLines.push(`      input_schema: ${schema}`)
      }
      const discoveryTools = tools
        .filter((t) => /^(list_|search_)/.test(t.name) && !hasRequiredArgs(t.inputSchema))
        .slice(0, 3)
      const discoveryResults = await Promise.all(
        discoveryTools.map(async (t) => {
          try {
            const text = await callTool(name, t.name, {})
            return { toolName: t.name, items: extractDiscoveryItems(text) }
          } catch {
            return { toolName: t.name, items: [] }
          }
        }),
      )
      const collected = discoveryResults
        .map((r) => formatDiscovery(r.toolName, r.items))
        .filter((s) => s.length > 0)
      if (collected.length > 0) {
        idLines.push(`  ${name}:`)
        for (const block of collected) idLines.push(block)
      }
      // Second-pass discovery: when the server has `execute_sql` and we
      // resolved opaque project IDs from list_projects, run a Postgres
      // information_schema dump per project so the binder sees real
      // table/column names instead of inventing them from the user's prose.
      // Triggered generically (any MCP server matching both criteria) but
      // the SQL is Postgres-flavoured — non-Postgres servers fail the call
      // silently and bind without schema context, same as before.
      const projectIds = discoveryResults
        .filter((r) => r.toolName === 'list_projects')
        .flatMap((r) => r.items.map((i) => i.id))
        .filter((id): id is string => typeof id === 'string')
        .slice(0, 5)
      const hasExecuteSql = tools.some((t) => t.name === 'execute_sql')
      if (hasExecuteSql && projectIds.length > 0) {
        // Compact one-row-per-table form via string_agg. The naive
        // one-row-per-column shape blows past the 20KB MCP body cap on real
        // schemas (40+ tables × verbose type strings); once the response is
        // truncated the JSON parse fails and the schema disappears from the
        // prompt entirely — leaving the binder to hallucinate names again.
        const sql =
          "SELECT s.table_name, " +
          "  string_agg(s.column_name || ':' || s.data_type, ',' " +
          "             ORDER BY s.ordinal_position) AS cols, " +
          "  MAX(s.approx_rows) AS approx_rows " +
          "FROM ( " +
          "  SELECT c.table_name, c.column_name, c.data_type, c.ordinal_position, " +
          "    COALESCE(pc.reltuples::bigint, 0) AS approx_rows " +
          "  FROM information_schema.columns c " +
          "  LEFT JOIN pg_class pc ON pc.relname = c.table_name " +
          "    AND pc.relnamespace = 'public'::regnamespace " +
          "  WHERE c.table_schema = 'public' " +
          ") s " +
          "GROUP BY s.table_name " +
          "ORDER BY s.table_name"
        const blocks = await Promise.all(
          projectIds.map(async (pid) => {
            try {
              const text = await callTool(name, 'execute_sql', {
                project_id: pid,
                query: sql,
              })
              return formatColumns(pid, text)
            } catch {
              return ''
            }
          }),
        )
        const used = blocks.filter((b) => b.length > 0)
        if (used.length > 0) {
          schemaLines.push(`  ${name}:`)
          for (const block of used) schemaLines.push(block)
        }
      }
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc)
      mcpLines.push(`  ${name}: (unavailable: ${message})`)
    }
  }

  const goal = userIntent && userIntent.trim().length > 0
    ? userIntent.trim()
    : '(no specific request — pick a reasonable default for this panel given the schema)'

  const prompt = `PANEL FRAME:
type: ${String(panel.type ?? '')}
title: ${String(panel.title ?? '')}
description: ${description ?? ''}
current_binding: ${JSON.stringify(panel.binding ?? null)}

AVAILABLE MCP SERVERS (with tool names):
${mcpLines.length > 0 ? mcpLines.join('\n') : '  (none connected)'}
${idLines.length > 0 ? `\nKNOWN IDENTIFIERS (resolved by calling discovery tools — use these IDs directly, do NOT pass the human-readable name as an opaque ID):\n${idLines.join('\n')}\n` : ''}${schemaLines.length > 0 ? `\nKNOWN MCP SCHEMAS (real tables resolved by calling discovery — when writing SQL for these projects, pick a table from this list and use its actual columns; do NOT invent table/column names from the user's prose):\n${schemaLines.join('\n')}\n` : ''}
TEAM DATA TABLES:
${tdLines.length > 0 ? tdLines.join('\n') : '  (no tables)'}

USER GOAL: ${goal}`

  const text = await chatCompletion({
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: buildSystemPrompt(String(panel.type ?? '')) },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  })

  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) {
    throw new Error(`AI binder did not return JSON. Got: ${text.slice(0, 300)}`)
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>
  } catch (exc) {
    throw new Error(
      `AI binder JSON parse failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    )
  }
  if (
    typeof parsed.source !== 'object' ||
    parsed.source === null ||
    typeof parsed.map !== 'object' ||
    parsed.map === null
  ) {
    throw new Error('AI binder output missing source/map')
  }
  // Pull setup_sql aside so it doesn't leak into the binding object that
  // gets persisted on the dashboard panel.
  const { setup_sql: setupSqlRaw, ...rest } = parsed as Record<string, unknown>
  const setupSql =
    typeof setupSqlRaw === 'string' && setupSqlRaw.trim().length > 0
      ? setupSqlRaw
      : undefined

  // Sanity check: when binder writes team_data SQL referencing a table
  // that's not in the live schema AND no setup_sql was emitted, the SELECT
  // will fail at runtime with a confusing "no such table" error. Catch
  // that here so the caller can surface a clear "AI invented a table"
  // message instead of an empty panel.
  const source = (rest.source ?? {}) as { kind?: unknown; config?: unknown }
  if (source.kind === 'team_data') {
    const sql = String(
      (source.config as { sql?: unknown } | undefined)?.sql ?? '',
    )
    const tableNames = extractFromTables(sql)
    const known = new Set((schema.tables ?? []).map((t) => t.name))
    const createdHere = setupSql ? extractCreatedTables(setupSql) : new Set<string>()
    const missing = tableNames.filter((t) => !known.has(t) && !createdHere.has(t))
    if (missing.length > 0) {
      throw new Error(
        `AI binder referenced unknown team_data table(s): ${missing.join(', ')}. ` +
          'It needed to emit a CREATE TABLE in setup_sql but did not. Try ' +
          'rephrasing your request with "새 테이블 <name> 만들어" or pick an ' +
          'existing table by name.',
      )
    }
  }
  // KPI currency guard. The binder likes to default `format:"currency"`
  // for anything titled "Target" / "Goal" / "이번 달 …", even when the SQL
  // is a plain COUNT/SUM of people, items, or sightings. Strip it unless
  // the SQL actually mentions a money-shaped identifier so panels don't
  // show "$16" / "₩16" for headcount.
  if (String(panel.type ?? '') === 'kpi') {
    const props = (rest.props as Record<string, unknown> | undefined) ?? {}
    if (String(props.format ?? '').toLowerCase() === 'currency') {
      const sql =
        source.kind === 'team_data'
          ? String((source.config as { sql?: unknown } | undefined)?.sql ?? '')
          : ''
      if (!looksLikeMoneySql(sql)) {
        delete (props as Record<string, unknown>).format
        delete (props as Record<string, unknown>).currency
        rest.props = props
      }
    }
  }

  // Backstop: small binder models routinely skip the `update` action even
  // when the chapter prompt asks for full CRUD. Without it, the row detail
  // modal can't show an Edit button. Synthesize update from create's SQL +
  // form fields when create exists but update doesn't, so non-developers
  // never see "Edit not available" just because the model's pattern-match
  // landed on "Add + Delete only". Same backstop for delete.
  if (String(panel.type ?? '') === 'table') {
    synthesizeMissingTableActions(rest)
  }

  // Self-heal: AI sometimes hallucinates columns ("created_at", "updated_at")
  // that don't exist in an MCP execute_sql target. The binding then renders
  // empty silently because Postgres errors get swallowed by the mapper. Fix
  // it before persisting: query information_schema for the target table and
  // strip any column the real table doesn't have, from BOTH the SELECT
  // clause and map.columns. Non-developers can't be expected to know which
  // column the AI invented — the system has to repair this autonomously.
  await healMcpExecuteSqlColumns(rest)

  // Backstop: keep the kanban binding self-describing even when the AI
  // emits a create/move action whose group_by select is missing options.
  // Source of truth is the CHECK constraint in setup_sql; we mirror it
  // into the action form so renderer and "+ Add" form share one taxonomy.
  if (String(panel.type ?? '') === 'kanban' && setupSql) {
    const groupBy = (rest.map as { group_by?: unknown } | undefined)?.group_by
    const actions = Array.isArray(rest.actions) ? (rest.actions as Record<string, unknown>[]) : null
    if (typeof groupBy === 'string' && actions) {
      const checkOptions = extractCheckOptions(setupSql, groupBy)
      if (checkOptions.length > 0) {
        for (const a of actions) {
          const fields = (a.form as { fields?: unknown } | undefined)?.fields
          if (!Array.isArray(fields)) continue
          for (const f of fields as Record<string, unknown>[]) {
            if (f.name !== groupBy) continue
            const opts = f.options
            if (!Array.isArray(opts) || opts.length === 0) f.options = checkOptions
          }
        }
      }
    }
  }
  return {
    binding: rest as unknown as PanelBinding,
    ...(setupSql ? { setupSql } : {}),
  }
}

/** Pull table names from FROM/JOIN clauses in a SELECT. Lowercased,
 *  unquoted. Doesn't try to handle subqueries or CTEs deeply — good
 *  enough for the simple SELECTs the binder writes. */
/** Heuristic: does this SQL look like it's reading a money-valued column?
 *  Triggers on common money identifiers in SELECT/aggregate/alias positions
 *  so a SUM(price) → currency, a COUNT(*) → not currency. Conservative —
 *  errs toward stripping when the column name doesn't say "money". */
export function looksLikeMoneySql(sql: string): boolean {
  const s = sql.toLowerCase()
  // Match identifiers like price, amount, revenue, cost, sales, fee, salary,
  // budget, balance, total_<money>, *_usd / *_krw / *_eur / *_btc, etc.
  // Bare tokens, possibly inside SUM(...) / AVG(...) / aliases (AS xxx).
  const pat =
    /\b(price|amount|revenue|cost|costs|sales|salary|wage|fee|fees|payment|payments|spend|spent|earned|earnings|budget|balance|gmv|arpu|mrr|arr|ltv|cac|profit|loss|invoice|invoiced|net|gross|tax|tip|tips|refund|refunded|payout|payouts|deposit|withdraw|charge|charges|due|paid|owe|owed|krw|usd|eur|jpy|gbp|cny|btc|eth|won|dollar|dollars|euro|euros|yen|pound|pounds|cash|money|cents|cent|cash_|_krw|_usd|_eur|_jpy|_gbp|_cny|_btc|_eth)\b/
  return pat.test(s)
}

/** Mirror create → update / delete on table bindings when binder skipped
 *  them. Reuses create's target.kind + project_id + table + form fields so
 *  the synthesized actions match the user's actual schema. Mutates in
 *  place. */
function synthesizeMissingTableActions(binding: Record<string, unknown>): void {
  const actions = Array.isArray(binding.actions)
    ? (binding.actions as Record<string, unknown>[])
    : null
  if (!actions) return
  const create = actions.find((a) => a.kind === 'create') as
    | Record<string, unknown>
    | undefined
  if (!create) return
  const createTarget = create.target as
    | { kind?: string; config?: Record<string, unknown> }
    | undefined
  if (!createTarget) return
  const createForm = create.form as { fields?: unknown[] } | undefined
  const fields = Array.isArray(createForm?.fields)
    ? (createForm!.fields as Record<string, unknown>[])
    : []

  const tableName = (() => {
    const sql = String(createTarget.config?.sql ?? '')
    const m1 = /insert\s+into\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.exec(sql)
    if (m1) return m1[1]!
    const tmpl = (createTarget.config?.args_template ?? {}) as Record<string, unknown>
    const q = String(tmpl.query ?? '')
    const m2 = /insert\s+into\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.exec(q)
    return m2?.[1] ?? null
  })()
  if (!tableName) return

  const hasUpdate = actions.some((a) => a.kind === 'update')
  const hasDelete = actions.some((a) => a.kind === 'delete')

  if (!hasUpdate && fields.length > 0) {
    const setters = fields
      .map((f) => String(f.name))
      .filter((n) => n.length > 0)
      .map((n) => `${n} = :${n}`)
      .join(', ')
    if (setters.length > 0) {
      const updateAction: Record<string, unknown> =
        createTarget.kind === 'team_data'
          ? {
              id: 'update',
              kind: 'update',
              label: 'Save',
              target: {
                kind: 'team_data',
                config: {
                  sql: `UPDATE ${tableName} SET ${setters} WHERE id = :id AND team_id = :team_id`,
                },
              },
              form: { fields: cloneFields(fields) },
            }
          : createTarget.kind === 'mcp'
            ? {
                id: 'update',
                kind: 'update',
                label: 'Save',
                target: {
                  kind: 'mcp',
                  config: {
                    server: (createTarget.config as Record<string, unknown>).server,
                    tool: 'execute_sql',
                    args_template: {
                      ...(typeof (createTarget.config as Record<string, unknown>)
                        .args_template === 'object'
                        ? (createTarget.config as { args_template: Record<string, unknown> })
                            .args_template
                        : {}),
                      query: `UPDATE ${tableName} SET ${fields
                        .map((f) => {
                          const n = String(f.name)
                          const t = String(f.type ?? 'text').toLowerCase()
                          const numeric = t === 'number'
                          return numeric ? `${n} = {{${n}}}` : `${n} = '{{${n}}}'`
                        })
                        .join(', ')} WHERE id = {{id}}`,
                    },
                  },
                },
                form: { fields: cloneFields(fields) },
              }
            : null
      if (updateAction) actions.push(updateAction)
    }
  }

  if (!hasDelete) {
    const deleteAction: Record<string, unknown> =
      createTarget.kind === 'team_data'
        ? {
            id: 'delete',
            kind: 'delete',
            label: 'Delete',
            target: {
              kind: 'team_data',
              config: {
                sql: `DELETE FROM ${tableName} WHERE id = :id AND team_id = :team_id`,
              },
            },
          }
        : createTarget.kind === 'mcp'
          ? {
              id: 'delete',
              kind: 'delete',
              label: 'Delete',
              target: {
                kind: 'mcp',
                config: {
                  server: (createTarget.config as Record<string, unknown>).server,
                  tool: 'execute_sql',
                  args_template: {
                    ...(typeof (createTarget.config as Record<string, unknown>)
                      .args_template === 'object'
                      ? (createTarget.config as { args_template: Record<string, unknown> })
                          .args_template
                      : {}),
                    query: `DELETE FROM ${tableName} WHERE id = {{id}}`,
                  },
                },
              },
            }
          : null
    if (deleteAction) actions.push(deleteAction)
  }
}

function cloneFields(fields: Record<string, unknown>[]): Record<string, unknown>[] {
  return fields.map((f) => ({ ...f }))
}

/** Strip AI-hallucinated columns from an mcp+execute_sql binding. Reads
 *  information_schema for the table being SELECTed, removes any column the
 *  real table doesn't have from both the SELECT projection and
 *  map.columns. Mutates `binding` in place. Silent no-op when the source
 *  isn't execute_sql, when we can't parse the SELECT, or when the schema
 *  query fails — never throws (this is a best-effort repair). */
async function healMcpExecuteSqlColumns(
  binding: Record<string, unknown>,
): Promise<void> {
  const source = binding.source as
    | { kind?: unknown; config?: { server?: unknown; tool?: unknown; args?: unknown } }
    | undefined
  if (!source || source.kind !== 'mcp') return
  const tool = String(source.config?.tool ?? '')
  if (tool !== 'execute_sql') return
  const server = String(source.config?.server ?? '')
  const args = (source.config?.args ?? {}) as Record<string, unknown>
  const sql = String(args.query ?? '')
  if (!server || !sql) return

  const parsed = parseSelectColumns(sql)
  if (!parsed) return
  const { table, columns } = parsed
  // SELECT * — nothing to strip.
  if (columns.length === 1 && columns[0] === '*') return

  let real: string[] = []
  try {
    const projectId = typeof args.project_id === 'string' ? args.project_id : null
    const probeArgs: Record<string, unknown> = {
      query:
        "SELECT column_name FROM information_schema.columns " +
        `WHERE table_name = '${table.replace(/'/g, "''")}' AND table_schema = 'public' ` +
        'ORDER BY ordinal_position',
    }
    if (projectId) probeArgs.project_id = projectId
    const text = await callTool(server, tool, probeArgs)
    real = extractColumnNames(text)
  } catch {
    return
  }
  if (real.length === 0) return
  const realSet = new Set(real)

  // Filter SELECT projection — keep ordering, drop unknown.
  const kept = columns.filter((c) => realSet.has(c.toLowerCase()))
  if (kept.length === 0) return // nothing salvageable; leave as-is
  if (kept.length === columns.length) return // all columns valid

  const newSql = sql.replace(
    /select\s+[\s\S]*?\s+from/i,
    `SELECT ${kept.join(', ')} FROM`,
  )
  ;(source.config as Record<string, unknown>).args = { ...args, query: newSql }

  const map = binding.map as Record<string, unknown> | undefined
  if (map && Array.isArray(map.columns)) {
    map.columns = (map.columns as unknown[]).filter(
      (c) => typeof c === 'string' && realSet.has(c.toLowerCase()),
    )
  }
}

/** Parse a simple `SELECT <cols> FROM <table>` projection. Returns null when
 *  the SELECT shape is too complex (subqueries, expressions with parens,
 *  CTEs). Aliases `col AS x` collapse to the underlying column name so we
 *  can compare against information_schema. */
function parseSelectColumns(
  sql: string,
): { table: string; columns: string[] } | null {
  const m = /^\s*select\s+([\s\S]+?)\s+from\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.exec(sql)
  if (!m) return null
  const projection = m[1]!
  const table = m[2]!.toLowerCase()
  // Bail on anything we don't safely understand — function calls, expressions
  // with commas inside parens, etc. Keep the heal conservative.
  if (/[()]/.test(projection)) return null
  const cols = projection
    .split(',')
    .map((p) => p.trim())
    .map((p) => p.replace(/\s+as\s+[a-zA-Z_][a-zA-Z0-9_]*$/i, '').trim())
    .filter((p) => p.length > 0)
  return { table, columns: cols }
}

/** Extract `column_name` values from a Supabase information_schema response.
 *  Handles both bare-array and object-wrapped JSON. */
function extractColumnNames(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  let rows: unknown[] = []
  if (Array.isArray(parsed)) rows = parsed
  else if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        rows = v
        break
      }
    }
  }
  const out: string[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const v = (r as Record<string, unknown>).column_name
    if (typeof v === 'string') out.push(v.toLowerCase())
  }
  return out
}

function extractFromTables(sql: string): string[] {
  const out = new Set<string>()
  const re = /\b(?:from|join)\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    out.add(m[1]!.toLowerCase())
  }
  return [...out]
}
function extractCreatedTables(sql: string): Set<string> {
  const out = new Set<string>()
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    out.add(m[1]!.toLowerCase())
  }
  return out
}

function hasRequiredArgs(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || typeof schema !== 'object') return false
  const required = (schema as { required?: unknown }).required
  return Array.isArray(required) && required.length > 0
}

/** Pull `{id, name}` pairs out of any array-shaped MCP discovery payload.
 *  Returns [] if nothing useful was found. Caps at 20 entries. */
function extractDiscoveryItems(
  text: string,
): { id: string | null; name: string | null }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  let items: unknown[] = []
  if (Array.isArray(parsed)) {
    items = parsed
  } else if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        items = v
        break
      }
    }
  }
  if (items.length === 0) return []
  const ID_KEYS = ['id', 'uuid', 'ref', 'slug', 'key']
  const NAME_KEYS = ['name', 'title', 'label', 'display_name', 'slug']
  const out: { id: string | null; name: string | null }[] = []
  for (const it of items.slice(0, 20)) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    let id: string | null = null
    let name: string | null = null
    for (const k of ID_KEYS) {
      const v = o[k]
      if (typeof v === 'string') {
        id = v
        break
      }
    }
    for (const k of NAME_KEYS) {
      const v = o[k]
      if (typeof v === 'string' && v !== id) {
        name = v
        break
      }
    }
    if (id || name) out.push({ id, name })
  }
  return out
}

function formatDiscovery(
  toolName: string,
  items: { id: string | null; name: string | null }[],
): string {
  const lines: string[] = []
  for (const { id, name } of items) {
    if (id && name) lines.push(`      - ${name} → ${id}`)
    else if (id) lines.push(`      - ${id}`)
  }
  if (lines.length === 0) return ''
  return `    ${toolName}:\n${lines.join('\n')}`
}

/** Group an information_schema.columns dump into `table(col:type, …)` lines
 *  the binder can read. Caps at ~30 tables / 40 cols per table to keep the
 *  prompt bounded. */
function formatColumns(projectId: string, text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return ''
  }
  let rows: unknown[] = []
  if (Array.isArray(parsed)) {
    rows = parsed
  } else if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        rows = v
        break
      }
    }
  }
  if (rows.length === 0) return ''
  // Normalise then sort by row count desc. Small binder models pick the
  // first table that "looks right" by name, so position is a stronger
  // tiebreaker than any prompt rule. Putting populated tables first means
  // when two siblings (e.g. `precedents` vs `external_precedents`) both
  // expose the same column, the populated one wins by default — without
  // hiding the empty sibling, which the user is still free to query
  // explicitly via the Code editor.
  const entries: { table: string; cols: string; approx: number }[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const table = typeof o.table_name === 'string' ? o.table_name : null
    const cols = typeof o.cols === 'string' ? o.cols : ''
    const approx = Number(o.approx_rows)
    if (!table || !cols) continue
    entries.push({ table, cols, approx: Number.isFinite(approx) ? approx : 0 })
  }
  if (entries.length === 0) return ''
  entries.sort((a, b) => b.approx - a.approx || a.table.localeCompare(b.table))
  const lines: string[] = [`    ${projectId}:`]
  for (const e of entries.slice(0, 30)) {
    const rowSuffix = e.approx > 0 ? ` ~${e.approx} rows` : ' EMPTY'
    const colsCapped = e.cols.length > 600 ? `${e.cols.slice(0, 600)}…` : e.cols
    lines.push(`      - ${e.table}(${colsCapped})${rowSuffix}`)
  }
  return lines.join('\n')
}

