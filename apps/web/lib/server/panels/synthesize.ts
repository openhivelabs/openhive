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
  return {
    id: SYNTH_KANBAN_MOVE_ID,
    kind: 'update',
    label: 'Move',
    placement: 'drag',
    fields: [ctx.groupBy],
    target: {
      kind: 'team_data',
      config: {
        sql: `UPDATE ${ctx.tableName} SET ${ctx.groupBy} = :${ctx.groupBy} WHERE id = :id AND team_id = :team_id`,
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

/** Return every CRUD action a kanban panel needs that the binding
 *  doesn't already carry. Each synthesized action has a stable reserved
 *  ID so the action endpoint can re-derive and execute it on demand. */
export function synthesizeKanbanActions(
  panelType: string,
  binding: Record<string, unknown>,
  companySlug: string,
): PanelAction[] {
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
