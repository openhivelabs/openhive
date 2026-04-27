/**
 * On-the-fly action synthesis for panels whose binding doesn't carry a
 * specific action but where the panel type implies one. Today the only
 * panel that gets synthesis is kanban — the binding is sometimes missing
 * an explicit move/create/update/delete (older bindings, or the AI
 * forgetting), but as long as the SELECT names a single team_data table
 * we can derive each action deterministically from the live schema.
 *
 * Used in two places that share one source of truth:
 *   - refresher.ts attaches the synthesized actions to panel data so the
 *     client knows which actions are wired and which IDs to call.
 *   - server/api/panels.ts falls back to the same synthesis when an
 *     incoming actionId isn't in the persisted binding, so the call
 *     actually executes.
 */
import type { FormField, PanelAction } from '@/lib/api/dashboards'
import {
  type ColumnInfo,
  extractCheckOptions,
  getTableColumns,
  getTableCreateSql,
} from '@/lib/server/team-data'

/** Reserved IDs for synthesized actions. Stable so the client and server
 *  agree on which IDs are valid without round-tripping the binding. */
export const SYNTH_KANBAN_MOVE_ID = 'kanban.move'
export const SYNTH_KANBAN_CREATE_ID = 'kanban.create'
export const SYNTH_KANBAN_UPDATE_ID = 'kanban.update'
export const SYNTH_KANBAN_DELETE_ID = 'kanban.delete'
export const SYNTH_TABLE_CREATE_ID = 'table.create'
export const SYNTH_TABLE_UPDATE_ID = 'table.update'
export const SYNTH_TABLE_DELETE_ID = 'table.delete'

/** Columns the synthesizer never asks the user about — they're either
 *  auto-bound by the action runner, auto-incrementing keys, or row
 *  metadata the DB defaults. Mirrors the form-panel rule in the AI
 *  prompt so synthesized and AI-emitted forms feel the same. */
const HIDDEN_COLUMNS = new Set(['team_id', 'id', 'created_at', 'updated_at'])

interface KanbanContext {
  groupBy: string
  tableName: string
  columns: ColumnInfo[]
  stageOptions: string[]
}

/** Inspect a kanban binding + the live company schema to gather every
 *  detail needed to synthesize the four CRUD actions. Returns null when
 *  the binding doesn't fit the team_data + single-table shape; callers
 *  fall back to whatever the binding itself carries. */
function getKanbanContext(
  panelType: string,
  binding: Record<string, unknown>,
  companySlug: string,
): KanbanContext | null {
  if (panelType !== 'kanban') return null
  const groupBy = (binding.map as { group_by?: unknown } | undefined)?.group_by
  if (typeof groupBy !== 'string' || !groupBy) return null
  const source = (binding.source ?? {}) as { kind?: unknown; config?: unknown }
  if (source.kind !== 'team_data') return null
  const sql = String((source.config as { sql?: unknown } | undefined)?.sql ?? '')
  const tableMatch = /\b(?:from|join)\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.exec(sql)
  const tableName = tableMatch?.[1]
  if (!tableName) return null
  const columns = getTableColumns(companySlug, tableName)
  if (columns.length === 0) return null
  if (!columns.some((c) => c.pk && c.name === 'id')) return null
  if (!columns.some((c) => c.name === groupBy)) return null
  const createSql = getTableCreateSql(companySlug, tableName) ?? ''
  const stageOptions = extractCheckOptions(createSql, groupBy)
  return { groupBy, tableName, columns, stageOptions }
}

function hasAction(
  binding: Record<string, unknown>,
  predicate: (a: PanelAction) => boolean,
): boolean {
  const actions = (binding.actions as PanelAction[] | undefined) ?? []
  return actions.some(predicate)
}

/** Map a SQLite column type + name into a form field. group_by becomes
 *  a select bound to the stage taxonomy; everything else falls back to
 *  type-inferred defaults. */
function fieldFromColumn(
  col: ColumnInfo,
  groupBy: string,
  stageOptions: string[],
): FormField {
  if (col.name === groupBy) {
    return {
      name: col.name,
      label: col.name,
      type: 'select',
      required: col.notnull,
      options: stageOptions.length > 0 ? stageOptions : undefined,
      ...(stageOptions[0] ? { default: stageOptions[0] } : {}),
    }
  }
  const type = (col.type ?? '').toUpperCase()
  if (/INT|REAL|NUM|DEC/.test(type)) {
    return { name: col.name, label: col.name, type: 'number', required: col.notnull }
  }
  if (/DATE|TIME/.test(type)) {
    return { name: col.name, label: col.name, type: 'date', required: col.notnull }
  }
  // Heuristic: long-form text columns get a textarea so users aren't
  // typing notes into a single-line input.
  if (/^(note|notes|description|details?)$/i.test(col.name)) {
    return { name: col.name, label: col.name, type: 'textarea', required: col.notnull }
  }
  return { name: col.name, label: col.name, type: 'text', required: col.notnull }
}

function writableColumns(columns: ColumnInfo[]): ColumnInfo[] {
  return columns.filter((c) => !HIDDEN_COLUMNS.has(c.name) && !c.pk)
}

function makeMoveAction(ctx: KanbanContext): PanelAction {
  // When the table carries a `sort_order` column, the drag action also
  // writes the dropped card's position. The KanbanView passes the new
  // sort_order alongside the new status so a single round-trip handles
  // both column-changes and within-column reorders.
  const hasSortOrder = ctx.columns.some((c) => c.name === 'sort_order')
  const setClause = hasSortOrder
    ? `${ctx.groupBy} = :${ctx.groupBy}, sort_order = :sort_order`
    : `${ctx.groupBy} = :${ctx.groupBy}`
  const fields = hasSortOrder ? [ctx.groupBy, 'sort_order'] : [ctx.groupBy]
  return {
    id: SYNTH_KANBAN_MOVE_ID,
    kind: 'update',
    label: 'Move',
    placement: 'drag',
    fields,
    target: {
      kind: 'team_data',
      config: {
        sql: `UPDATE ${ctx.tableName} SET ${setClause} WHERE id = :id AND team_id = :team_id`,
      },
    },
  }
}

function makeCreateAction(ctx: KanbanContext): PanelAction | null {
  const cols = writableColumns(ctx.columns)
  if (cols.length === 0) return null
  const colNames = cols.map((c) => c.name)
  const placeholders = colNames.map((n) => `:${n}`)
  return {
    id: SYNTH_KANBAN_CREATE_ID,
    kind: 'create',
    label: 'Add',
    placement: 'toolbar',
    target: {
      kind: 'team_data',
      config: {
        sql: `INSERT INTO ${ctx.tableName} (${[...colNames, 'team_id'].join(', ')}) VALUES (${[...placeholders, ':team_id'].join(', ')})`,
      },
    },
    form: {
      fields: cols.map((c) => fieldFromColumn(c, ctx.groupBy, ctx.stageOptions)),
    },
  }
}

function makeUpdateAction(ctx: KanbanContext): PanelAction | null {
  const cols = writableColumns(ctx.columns)
  if (cols.length === 0) return null
  const setClause = cols.map((c) => `${c.name} = :${c.name}`).join(', ')
  return {
    id: SYNTH_KANBAN_UPDATE_ID,
    kind: 'update',
    label: 'Save',
    placement: 'row',
    target: {
      kind: 'team_data',
      config: {
        sql: `UPDATE ${ctx.tableName} SET ${setClause} WHERE id = :id AND team_id = :team_id`,
      },
    },
    form: {
      fields: cols.map((c) => fieldFromColumn(c, ctx.groupBy, ctx.stageOptions)),
    },
  }
}

function makeDeleteAction(ctx: KanbanContext): PanelAction {
  return {
    id: SYNTH_KANBAN_DELETE_ID,
    kind: 'delete',
    label: 'Delete',
    placement: 'row',
    confirm: true,
    target: {
      kind: 'team_data',
      config: {
        sql: `DELETE FROM ${ctx.tableName} WHERE id = :id AND team_id = :team_id`,
      },
    },
  }
}

interface McpKanbanContext {
  tableName: string
  server: string
  projectId: string | null
  groupBy: string
  /** Field names from the SELECT projection minus id / sort_order /
   *  team_id / created_at — the writable subset used for create/update
   *  forms. */
  writableNames: string[]
  /** True when SELECT projection includes `team_id`. */
  hasTeamId: boolean
  /** True when SELECT projection includes `sort_order`. */
  hasSortOrder: boolean
  /** Stage labels resolved from the binding's create/update form select
   *  options for `groupBy`. Empty when the binding doesn't carry any —
   *  KanbanView falls back to data.groups in that case. */
  stageOptions: string[]
}

function getMcpKanbanContext(
  panelType: string,
  binding: Record<string, unknown>,
): McpKanbanContext | null {
  if (panelType !== 'kanban') return null
  const groupBy = (binding.map as { group_by?: unknown } | undefined)?.group_by
  if (typeof groupBy !== 'string' || !groupBy) return null
  const source = (binding.source ?? {}) as {
    kind?: unknown
    config?: { server?: unknown; tool?: unknown; args?: unknown }
  }
  if (source.kind !== 'mcp') return null
  if (String(source.config?.tool ?? '') !== 'execute_sql') return null
  const server = String(source.config?.server ?? '')
  if (!server) return null
  const args = (source.config?.args ?? {}) as Record<string, unknown>
  const sql = String(args.query ?? '')
  const fromMatch = /\bfrom\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.exec(sql)
  const tableName = fromMatch?.[1]
  if (!tableName) return null
  const projMatch = /^\s*select\s+([\s\S]+?)\s+from\b/i.exec(sql)
  if (!projMatch) return null
  const projection = projMatch[1]!
  if (/[()]/.test(projection)) return null
  const cols = projection
    .split(',')
    .map((p) => p.trim())
    .map((p) => p.replace(/\s+as\s+[a-zA-Z_][a-zA-Z0-9_]*$/i, '').trim())
    .filter((p) => p.length > 0 && p !== '*')
  if (!cols.includes('id')) return null
  if (!cols.includes(groupBy)) return null
  const hidden = new Set(['id', 'team_id', 'created_at', 'updated_at', 'sort_order'])
  const writableNames = cols.filter((c) => !hidden.has(c))
  // Pull stage options from any binding action's form select for groupBy.
  const stageOptions: string[] = (() => {
    const actions = Array.isArray(binding.actions) ? (binding.actions as PanelAction[]) : []
    for (const a of actions) {
      const f = a.form?.fields?.find((x) => x.name === groupBy)
      if (f?.options && f.options.length > 0) {
        return f.options.map((o) => String(o)).filter((s) => s.length > 0)
      }
    }
    return []
  })()
  return {
    tableName,
    server,
    projectId: typeof args.project_id === 'string' ? args.project_id : null,
    groupBy,
    writableNames,
    hasTeamId: cols.includes('team_id'),
    hasSortOrder: cols.includes('sort_order'),
    stageOptions,
  }
}

function mcpKanbanFieldFromName(
  name: string,
  groupBy: string,
  stageOptions: string[],
): FormField {
  if (name === groupBy) {
    return {
      name,
      label: name,
      type: 'select',
      required: true,
      options: stageOptions.length > 0 ? stageOptions : undefined,
      ...(stageOptions[0] ? { default: stageOptions[0] } : {}),
    }
  }
  if (/^(is_|has_|can_|should_)|_flag$|^active$|^enabled$|^visible$/i.test(name)) {
    return { name, label: name, type: 'select', options: ['true', 'false'], default: 'false' }
  }
  if (/^id$|_id$|count|score|amount|price|qty|quantity|priority/i.test(name)) {
    return { name, label: name, type: 'number' }
  }
  if (/_at$|_date$|^date$/i.test(name)) {
    return { name, label: name, type: 'date' }
  }
  if (/^(note|notes|description|details?|purpose|memo)$/i.test(name)) {
    return { name, label: name, type: 'textarea' }
  }
  return { name, label: name, type: 'text' }
}

function makeMcpKanbanActions(ctx: McpKanbanContext): PanelAction[] {
  const baseConfig: Record<string, unknown> = { server: ctx.server, tool: 'execute_sql' }
  const baseTmpl: Record<string, unknown> = ctx.projectId ? { project_id: ctx.projectId } : {}
  const fields = ctx.writableNames.map((n) =>
    mcpKanbanFieldFromName(n, ctx.groupBy, ctx.stageOptions),
  )
  const valueExpr = (f: FormField): string =>
    f.type === 'number' ? `{{${f.name}}}` : `'{{${f.name}}}'`

  // INSERT
  const insertCols = ctx.hasTeamId
    ? [...ctx.writableNames, 'team_id']
    : ctx.writableNames
  const insertVals = ctx.hasTeamId
    ? [...fields.map(valueExpr), `'{{team_id}}'`]
    : fields.map(valueExpr)
  const tenantWhere = ctx.hasTeamId ? ` AND team_id = '{{team_id}}'` : ''

  const out: PanelAction[] = [
    {
      id: SYNTH_KANBAN_CREATE_ID,
      kind: 'create',
      label: 'Add',
      target: {
        kind: 'mcp',
        config: {
          ...baseConfig,
          args_template: {
            ...baseTmpl,
            query: `INSERT INTO ${ctx.tableName} (${insertCols.join(', ')}) VALUES (${insertVals.join(', ')})`,
          },
        },
      },
      form: { fields },
    } as PanelAction,
    {
      id: SYNTH_KANBAN_UPDATE_ID,
      kind: 'update',
      label: 'Save',
      target: {
        kind: 'mcp',
        config: {
          ...baseConfig,
          args_template: {
            ...baseTmpl,
            query: `UPDATE ${ctx.tableName} SET ${fields
              .map((f) => `${f.name} = ${valueExpr(f)}`)
              .join(', ')} WHERE id = {{id}}${tenantWhere}`,
          },
        },
      },
      form: { fields },
    } as PanelAction,
    {
      id: SYNTH_KANBAN_DELETE_ID,
      kind: 'delete',
      label: 'Delete',
      confirm: true,
      target: {
        kind: 'mcp',
        config: {
          ...baseConfig,
          args_template: {
            ...baseTmpl,
            query: `DELETE FROM ${ctx.tableName} WHERE id = {{id}}${tenantWhere}`,
          },
        },
      },
    } as PanelAction,
  ]

  // Drag-move action — also writes sort_order when the table has it.
  const moveSetClause = ctx.hasSortOrder
    ? `${ctx.groupBy} = '{{${ctx.groupBy}}}', sort_order = {{sort_order}}`
    : `${ctx.groupBy} = '{{${ctx.groupBy}}}'`
  const moveFields = ctx.hasSortOrder
    ? [ctx.groupBy, 'sort_order']
    : [ctx.groupBy]
  out.push({
    id: SYNTH_KANBAN_MOVE_ID,
    kind: 'update',
    label: 'Move',
    placement: 'drag',
    fields: moveFields,
    target: {
      kind: 'mcp',
      config: {
        ...baseConfig,
        args_template: {
          ...baseTmpl,
          query: `UPDATE ${ctx.tableName} SET ${moveSetClause} WHERE id = {{id}}${tenantWhere}`,
        },
      },
    },
  } as PanelAction)

  return out
}

/** Return every CRUD action a kanban panel needs that the binding
 *  doesn't already carry. Each synthesized action has a stable reserved
 *  ID so the action endpoint can re-derive and execute it on demand. */
export function synthesizeKanbanActions(
  panelType: string,
  binding: Record<string, unknown>,
  companySlug: string,
): PanelAction[] {
  // External path — synthesizer is authoritative; binder INSERTs are
  // unreliable for mcp sources, so always emit and let the client merger
  // drop kind-conflicting persisted actions for kanban+mcp panels.
  const mcpCtx = getMcpKanbanContext(panelType, binding)
  if (mcpCtx) return makeMcpKanbanActions(mcpCtx)

  const ctx = getKanbanContext(panelType, binding, companySlug)
  if (!ctx) return []
  const out: PanelAction[] = []

  if (
    !hasAction(
      binding,
      (a) => a.kind === 'update' && (a.fields ?? []).includes(ctx.groupBy),
    )
  ) {
    out.push(makeMoveAction(ctx))
  }
  if (!hasAction(binding, (a) => a.kind === 'create')) {
    const create = makeCreateAction(ctx)
    if (create) out.push(create)
  }
  if (
    !hasAction(
      binding,
      // a generic update (not the drag-only move) — anything matching
      // the row's primary key is good enough to count as "edit exists".
      (a) =>
        a.kind === 'update' &&
        a.placement !== 'drag' &&
        (a.form?.fields?.length ?? 0) > 0,
    )
  ) {
    const update = makeUpdateAction(ctx)
    if (update) out.push(update)
  }
  if (!hasAction(binding, (a) => a.kind === 'delete')) {
    out.push(makeDeleteAction(ctx))
  }

  return out
}

interface TableContext {
  tableName: string
  columns: ColumnInfo[]
}

/** Inspect a table binding to gather what's needed for CRUD synthesis.
 *  Mirrors `getKanbanContext` shape. Bails on non-team_data sources or
 *  when the SELECT names a table the schema doesn't know — synthesis is
 *  best-effort. */
function getTableContext(
  panelType: string,
  binding: Record<string, unknown>,
  companySlug: string,
): TableContext | null {
  if (panelType !== 'table') return null
  const source = (binding.source ?? {}) as { kind?: unknown; config?: unknown }
  if (source.kind !== 'team_data') return null
  const sql = String((source.config as { sql?: unknown } | undefined)?.sql ?? '')
  const tableMatch = /\b(?:from|join)\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.exec(sql)
  const tableName = tableMatch?.[1]
  if (!tableName) return null
  const columns = getTableColumns(companySlug, tableName)
  if (columns.length === 0) return null
  if (!columns.some((c) => c.pk && c.name === 'id')) return null
  return { tableName, columns }
}

interface McpTableContext {
  tableName: string
  server: string
  projectId: string | null
  /** Column names parsed out of the SELECT projection, minus `id`. We don't
   *  know real types without an information_schema fetch, so fields use a
   *  text/number heuristic on the column NAME alone. Acceptable for MVP —
   *  the alternative is an extra MCP call on every refresh. */
  writableNames: string[]
  /** True when the SELECT exposed a `team_id` column — strong signal the
   *  external table has a tenant column we should bind on writes (INSERT
   *  values, UPDATE/DELETE WHERE). The action runner injects the OpenHive
   *  team id under the `team_id` template key automatically. */
  hasTeamId: boolean
}

function getMcpTableContext(
  panelType: string,
  binding: Record<string, unknown>,
): McpTableContext | null {
  if (panelType !== 'table') return null
  const source = (binding.source ?? {}) as { kind?: unknown; config?: { server?: unknown; tool?: unknown; args?: unknown } }
  if (source.kind !== 'mcp') return null
  if (String(source.config?.tool ?? '') !== 'execute_sql') return null
  const server = String(source.config?.server ?? '')
  if (!server) return null
  const args = (source.config?.args ?? {}) as Record<string, unknown>
  const sql = String(args.query ?? '')
  const fromMatch = /\bfrom\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.exec(sql)
  const tableName = fromMatch?.[1]
  if (!tableName) return null
  const projMatch = /^\s*select\s+([\s\S]+?)\s+from\b/i.exec(sql)
  if (!projMatch) return null
  const projection = projMatch[1]!
  if (/[()]/.test(projection)) return null
  const cols = projection
    .split(',')
    .map((p) => p.trim())
    .map((p) => p.replace(/\s+as\s+[a-zA-Z_][a-zA-Z0-9_]*$/i, '').trim())
    .filter((p) => p.length > 0 && p !== '*')
  if (cols.length === 0) return null
  // SELECT must include id so update/delete can target the row.
  if (!cols.includes('id')) return null
  const writableNames = cols.filter((c) => !HIDDEN_COLUMNS.has(c))
  if (writableNames.length === 0) return null
  return {
    tableName,
    server,
    projectId: typeof args.project_id === 'string' ? args.project_id : null,
    writableNames,
    hasTeamId: cols.includes('team_id'),
  }
}

/** Heuristic field shape from a bare column name (no type info). Numbers
 *  for `*_id`, `score`-like, `*_at`/`*_date` for dates, boolean-style
 *  names get a true/false select, otherwise text. */
function mcpFieldFromName(name: string): FormField {
  if (/^(is_|has_|can_|should_)|_flag$|^victory$|^active$|^enabled$|^visible$/i.test(name)) {
    return {
      name,
      label: name,
      type: 'select',
      options: ['true', 'false'],
      default: 'false',
    }
  }
  if (/^id$|_id$|count|score|amount|price|qty|quantity|combo|sec$|duration|coins/i.test(name)) {
    return { name, label: name, type: 'number' }
  }
  if (/_at$|_date$|^date$/i.test(name)) {
    return { name, label: name, type: 'datetime-local' }
  }
  return { name, label: name, type: 'text' }
}

function makeMcpTableActions(ctx: McpTableContext): PanelAction[] {
  const out: PanelAction[] = []
  const baseConfig: Record<string, unknown> = { server: ctx.server, tool: 'execute_sql' }
  const baseTmpl: Record<string, unknown> = ctx.projectId ? { project_id: ctx.projectId } : {}

  const fields = ctx.writableNames.map(mcpFieldFromName)
  // Quote text/date placeholders, leave numbers raw. SQL injection risk is
  // accepted at MVP scope — the panel mutates the user's own external DB.
  const valueExpr = (f: FormField): string =>
    f.type === 'number' ? `{{${f.name}}}` : `'{{${f.name}}}'`

  const insertCols = ctx.hasTeamId
    ? [...ctx.writableNames, 'team_id']
    : ctx.writableNames
  const insertVals = ctx.hasTeamId
    ? [...fields.map(valueExpr), `'{{team_id}}'`]
    : fields.map(valueExpr)
  const tenantWhere = ctx.hasTeamId ? ` AND team_id = '{{team_id}}'` : ''

  out.push({
    id: SYNTH_TABLE_CREATE_ID,
    kind: 'create',
    label: 'Add',
    target: {
      kind: 'mcp',
      config: {
        ...baseConfig,
        args_template: {
          ...baseTmpl,
          query: `INSERT INTO ${ctx.tableName} (${insertCols.join(', ')}) VALUES (${insertVals.join(', ')})`,
        },
      },
    },
    form: { fields },
  } as PanelAction)

  out.push({
    id: SYNTH_TABLE_UPDATE_ID,
    kind: 'update',
    label: 'Save',
    target: {
      kind: 'mcp',
      config: {
        ...baseConfig,
        args_template: {
          ...baseTmpl,
          query: `UPDATE ${ctx.tableName} SET ${fields
            .map((f) => `${f.name} = ${valueExpr(f)}`)
            .join(', ')} WHERE id = {{id}}${tenantWhere}`,
        },
      },
    },
    form: { fields },
  } as PanelAction)

  out.push({
    id: SYNTH_TABLE_DELETE_ID,
    kind: 'delete',
    label: 'Delete',
    confirm: true,
    target: {
      kind: 'mcp',
      config: {
        ...baseConfig,
        args_template: {
          ...baseTmpl,
          query: `DELETE FROM ${ctx.tableName} WHERE id = {{id}}${tenantWhere}`,
        },
      },
    },
  } as PanelAction)

  return out
}

/** Same field-from-column heuristic as kanban's, minus the group_by select
 *  branch — table forms have no stage taxonomy. */
function tableFieldFromColumn(col: ColumnInfo): FormField {
  const type = (col.type ?? '').toUpperCase()
  if (/INT|REAL|NUM|DEC/.test(type)) {
    return { name: col.name, label: col.name, type: 'number', required: col.notnull }
  }
  if (/DATE|TIME/.test(type)) {
    return { name: col.name, label: col.name, type: 'date', required: col.notnull }
  }
  if (/^(note|notes|description|details?)$/i.test(col.name)) {
    return { name: col.name, label: col.name, type: 'textarea', required: col.notnull }
  }
  return { name: col.name, label: col.name, type: 'text', required: col.notnull }
}

function makeTableCreateAction(ctx: TableContext): PanelAction | null {
  const cols = writableColumns(ctx.columns)
  if (cols.length === 0) return null
  const colNames = cols.map((c) => c.name)
  return {
    id: SYNTH_TABLE_CREATE_ID,
    kind: 'create',
    label: 'Add',
    target: {
      kind: 'team_data',
      config: {
        sql: `INSERT INTO ${ctx.tableName} (${[...colNames, 'team_id'].join(', ')}) VALUES (${[
          ...colNames.map((n) => `:${n}`),
          ':team_id',
        ].join(', ')})`,
      },
    },
    form: { fields: cols.map(tableFieldFromColumn) },
  }
}

function makeTableUpdateAction(ctx: TableContext): PanelAction | null {
  const cols = writableColumns(ctx.columns)
  if (cols.length === 0) return null
  const setClause = cols.map((c) => `${c.name} = :${c.name}`).join(', ')
  return {
    id: SYNTH_TABLE_UPDATE_ID,
    kind: 'update',
    label: 'Save',
    target: {
      kind: 'team_data',
      config: {
        sql: `UPDATE ${ctx.tableName} SET ${setClause} WHERE id = :id AND team_id = :team_id`,
      },
    },
    form: { fields: cols.map(tableFieldFromColumn) },
  }
}

function makeTableDeleteAction(ctx: TableContext): PanelAction {
  return {
    id: SYNTH_TABLE_DELETE_ID,
    kind: 'delete',
    label: 'Delete',
    confirm: true,
    target: {
      kind: 'team_data',
      config: {
        sql: `DELETE FROM ${ctx.tableName} WHERE id = :id AND team_id = :team_id`,
      },
    },
  }
}

/** Mirror of `synthesizeKanbanActions` for table panels. Fills in any of
 *  the CRUD trio the binding doesn't already declare so the row detail
 *  modal always has Edit + Delete on team_data tables, even when the AI
 *  binder forgot to emit them. */
export function synthesizeTableActions(
  panelType: string,
  binding: Record<string, unknown>,
  companySlug: string,
): PanelAction[] {
  const ctx = getTableContext(panelType, binding, companySlug)
  if (ctx) {
    const out: PanelAction[] = []
    if (!hasAction(binding, (a) => a.kind === 'create')) {
      const create = makeTableCreateAction(ctx)
      if (create) out.push(create)
    }
    if (
      !hasAction(
        binding,
        (a) => a.kind === 'update' && (a.form?.fields?.length ?? 0) > 0,
      )
    ) {
      const update = makeTableUpdateAction(ctx)
      if (update) out.push(update)
    }
    if (!hasAction(binding, (a) => a.kind === 'delete')) {
      out.push(makeTableDeleteAction(ctx))
    }
    return out
  }
  // External path — always emit. Binder-generated INSERT/UPDATE for mcp
  // sources is unreliable (skips team_id, mismatched quoting, missing
  // tenant filter), so the synthesizer takes over as the authoritative
  // CRUD path. The client-side merger drops kind-conflicting persisted
  // actions in favour of these for table panels.
  const mcpCtx = getMcpTableContext(panelType, binding)
  if (mcpCtx) return makeMcpTableActions(mcpCtx)
  return []
}

/** Backward-compat single-action accessor — refresher used to call this
 *  before the full CRUD synthesis. Kept so older import sites compile
 *  cleanly; new callers should prefer `synthesizeKanbanActions`. */
export function synthesizeKanbanMoveAction(
  panelType: string,
  binding: Record<string, unknown>,
  companySlug?: string,
): PanelAction | null {
  if (!companySlug) return null
  const ctx = getKanbanContext(panelType, binding, companySlug)
  if (!ctx) return null
  if (
    hasAction(
      binding,
      (a) => a.kind === 'update' && (a.fields ?? []).includes(ctx.groupBy),
    )
  ) {
    return null
  }
  return makeMoveAction(ctx)
}
