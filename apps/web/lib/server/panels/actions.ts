/**
 * Panel action executor — the write path.
 *
 * Flow:
 *   1. Look up the PanelSpec in dashboard.yaml (via loadDashboard)
 *   2. Find the named action inside panel.binding.actions
 *   3. Validate user-supplied values against the action's form schema
 *   4. Dispatch to the target kind (team_data / mcp / http_recipe / http_raw / file)
 *   5. Invalidate the panel's read cache so the UI refetches
 *
 * Security posture:
 *   - SQL templates run via better-sqlite3 parameter binding (`stmt.run({name: ...})`),
 *     never string concat. Multi-statement / DDL rejected at the regex layer.
 *   - `auth_ref` resolves to a credential value server-side only; it is never
 *     returned in any response (success or error).
 *   - MCP/http args use `{{field}}` placeholder substitution from the same
 *     validated values map — AI cannot smuggle raw values from outside.
 */

import { withCompanyDb } from '../team-data'
import { callTool as mcpCallTool } from '../mcp/manager'
import { getCredentialValue } from '../credentials'
import { logPanelAction } from './audit'
import { deleteCache } from './cache'

interface ActionContext {
  companySlug: string
  teamSlug: string
  teamId: string
}

interface FormFieldSpec {
  name: string
  label?: string
  type?: string
  required?: boolean
  options?: string[]
  min?: number
  max?: number
  default?: unknown
}

interface FormSchemaSpec {
  fields?: FormFieldSpec[]
}

interface ActionTargetSpec {
  kind: string
  config?: Record<string, unknown>
  auth_ref?: string
}

export interface PanelActionSpec {
  id: string
  kind: 'create' | 'update' | 'delete' | 'custom'
  label?: string
  placement?: string
  form?: FormSchemaSpec
  fields?: string[]
  target: ActionTargetSpec
  confirm?: boolean
  irreversible?: boolean
}

export class ActionError extends Error {}

// ---------- validation ----------

const SQL_WRITE_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i
const SQL_DENY_RE = /\b(PRAGMA|ATTACH|DETACH|VACUUM|DROP|ALTER|CREATE|TRUNCATE)\b/i

function validateValues(
  form: FormSchemaSpec | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const fields = form?.fields ?? []
  for (const field of fields) {
    const raw = values[field.name] ?? field.default
    if (field.required && (raw === undefined || raw === null || raw === '')) {
      throw new ActionError(`field "${field.name}" is required`)
    }
    if (raw === undefined) continue
    out[field.name] = coerceField(field, raw)
  }
  // Pass through fields not declared in form (useful for row-level updates where
  // `id` is injected by the UI). Restricted to primitives.
  for (const [k, v] of Object.entries(values)) {
    if (k in out) continue
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v
    }
  }
  return out
}

function coerceField(field: FormFieldSpec, raw: unknown): unknown {
  switch (field.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) {
        throw new ActionError(`field "${field.name}" must be a number`)
      }
      if (typeof field.min === 'number' && n < field.min) {
        throw new ActionError(`field "${field.name}" must be >= ${field.min}`)
      }
      if (typeof field.max === 'number' && n > field.max) {
        throw new ActionError(`field "${field.name}" must be <= ${field.max}`)
      }
      return n
    }
    case 'toggle':
      return Boolean(raw)
    case 'select':
      if (
        field.options &&
        !field.options.map((o) => String(o)).includes(String(raw))
      ) {
        throw new ActionError(
          `field "${field.name}" must be one of ${field.options.map((o) => String(o)).join(', ')}`,
        )
      }
      return String(raw)
    case 'date':
    case 'datetime':
    case 'text':
    case 'textarea':
    default:
      return String(raw)
  }
}

// ---------- execution ----------

export async function executeAction(
  ctx: ActionContext,
  panelId: string,
  action: PanelActionSpec,
  rawValues: Record<string, unknown>,
): Promise<{ ok: true; result?: unknown; rows_changed?: number }> {
  const values = validateValues(action.form, rawValues)
  let result: unknown = null
  let rowsChanged: number | undefined
  try {
    switch (action.target.kind) {
      case 'team_data':
        rowsChanged = execTeamDataAction(ctx, action, values)
        break
      case 'mcp':
        // Inject team_id like team_data does so external tables with a
        // tenant column can write under the OpenHive team scope without
        // the binder having to learn it as a form field.
        result = await execMcpAction(action, { ...values, team_id: ctx.teamId })
        break
      case 'http_recipe':
      case 'http_raw':
        result = await execHttpAction(action, values)
        break
      default:
        throw new ActionError(`unsupported action target: ${action.target.kind}`)
    }
  } catch (err) {
    logPanelAction(ctx.companySlug, ctx.teamSlug, {
      panel_id: panelId,
      action_id: action.id,
      action_kind: action.kind,
      target_kind: action.target.kind,
      values,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  deleteCache(panelId)
  logPanelAction(ctx.companySlug, ctx.teamSlug, {
    panel_id: panelId,
    action_id: action.id,
    action_kind: action.kind,
    target_kind: action.target.kind,
    values,
    rows_changed: rowsChanged,
    result_summary:
      result === null || result === undefined
        ? undefined
        : JSON.stringify(result).slice(0, 200),
  })
  return { ok: true, result, rows_changed: rowsChanged }
}

function execTeamDataAction(
  ctx: ActionContext,
  action: PanelActionSpec,
  values: Record<string, unknown>,
): number {
  const sql = String(action.target.config?.sql ?? '').trim()
  if (!sql) throw new ActionError('team_data action requires sql')
  if (!SQL_WRITE_RE.test(sql)) {
    throw new ActionError('team_data action allows only INSERT/UPDATE/DELETE')
  }
  if (SQL_DENY_RE.test(sql)) {
    throw new ActionError('team_data action contains disallowed keyword')
  }
  if (sql.includes(';') && !/;\s*$/.test(sql)) {
    throw new ActionError('team_data action must be a single statement')
  }
  // Safety: writes must carry team_id so teams can't clobber each other's
  // rows through the shared company DB. INSERT must mention the column;
  // UPDATE/DELETE must filter on it. We require an explicit `:team_id`
  // binding in the SQL — auto-rewriting is too fragile to be worth it.
  const head = sql.slice(0, 12).toUpperCase()
  if (head.startsWith('INSERT')) {
    if (!/\bteam_id\b/i.test(sql)) {
      throw new ActionError(
        'INSERT must include a team_id column bound to :team_id',
      )
    }
  } else if (head.startsWith('UPDATE') || head.startsWith('DELETE')) {
    if (!/\bteam_id\s*=\s*:team_id\b/i.test(sql)) {
      throw new ActionError(
        `${head.split(' ')[0]} must filter on team_id = :team_id in the WHERE clause`,
      )
    }
  }
  // Collect all :name references in the SQL. Fill missing params with null so
  // optional form fields (e.g. an empty date) insert as NULL instead of
  // crashing the statement. `team_id` is auto-bound from the action context.
  const paramNames = Array.from(sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)).map(
    (m) => m[1] as string,
  )
  const bound: Record<string, unknown> = { team_id: ctx.teamId }
  for (const n of paramNames) {
    if (n === 'team_id') continue
    const v = values[n]
    bound[n] = v === undefined || v === '' ? null : v
  }
  return withCompanyDb(ctx.companySlug, (conn) => {
    const stmt = conn.prepare(sql)
    const info = stmt.run(bound)
    return info.changes
  })
}

async function execMcpAction(
  action: PanelActionSpec,
  values: Record<string, unknown>,
): Promise<unknown> {
  const server = String(action.target.config?.server ?? '')
  const tool = String(action.target.config?.tool ?? '')
  if (!server || !tool) throw new ActionError('mcp action requires server + tool')
  // Two binder formats coexist for mcp actions:
  //   1. args_template with `{{var}}` placeholders — synthesizer + new
  //      kanban/table prompt output. Rendered through renderTemplate.
  //   2. plain args with `:var` placeholders inline (especially in
  //      `query`) — older calendar / kpi binder output. Without
  //      substitution Supabase receives literal `:var` strings and
  //      errors out. We sub them in here so binder-emitted actions work
  //      even before the prompt is updated.
  const template = action.target.config?.args_template
  const rawArgs = action.target.config?.args
  let args: Record<string, unknown>
  if (template && typeof template === 'object' && !Array.isArray(template)) {
    args = renderTemplate(template as Record<string, unknown>, values)
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = renderColonTemplate(rawArgs as Record<string, unknown>, values)
  } else {
    args = values
  }
  const text = await mcpCallTool(server, tool, args as Record<string, unknown>)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function execHttpAction(
  action: PanelActionSpec,
  values: Record<string, unknown>,
): Promise<unknown> {
  const cfg = action.target.config ?? {}
  const url = String(cfg.url ?? '')
  if (!url) throw new ActionError('http action requires url')
  const method = String(cfg.method ?? 'POST').toUpperCase()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((cfg.headers as Record<string, string> | undefined) ?? {}),
  }
  if (action.target.auth_ref) {
    const token = getCredentialValue(action.target.auth_ref)
    if (!token) {
      throw new ActionError(`auth_ref "${action.target.auth_ref}" not found`)
    }
    const h = String(cfg.auth_header ?? 'Authorization')
    const scheme = String(cfg.auth_scheme ?? 'Bearer')
    headers[h] = scheme ? `${scheme} ${token}` : token
  }
  const body = cfg.body_template
    ? renderTemplate(cfg.body_template as Record<string, unknown>, values)
    : values
  const resp = await fetch(renderString(url, values), {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw new ActionError(`http ${resp.status}: ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ---------- helpers ----------

function renderTemplate(
  template: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(template)) {
    if (typeof v === 'string') {
      out[k] = renderString(v, values)
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = renderTemplate(v as Record<string, unknown>, values)
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) =>
        typeof x === 'string'
          ? renderString(x, values)
          : x && typeof x === 'object'
            ? renderTemplate(x as Record<string, unknown>, values)
            : x,
      )
    } else {
      out[k] = v
    }
  }
  return out
}

function renderString(s: string, values: Record<string, unknown>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = values[k]
    return v === undefined || v === null ? '' : String(v)
  })
}

/** Substitute `:placeholder` tokens in any string field of an args object,
 *  matching the SQL parameter syntax the binder uses for team_data
 *  actions. Strings (text / date) are wrapped in single quotes; numbers
 *  stay raw. Used by execMcpAction so binder-emitted mcp actions whose
 *  `query` carries inline `:var` placeholders run correctly without
 *  forcing every binder to switch to args_template + {{var}}. */
function renderColonTemplate(
  template: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(template)) {
    if (typeof v === 'string') {
      out[k] = v.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name: string) => {
        if (!(name in values)) return m
        const val = values[name]
        if (val === null || val === undefined) return 'NULL'
        if (typeof val === 'number' || typeof val === 'boolean') return String(val)
        // Escape single quotes for SQL string literals.
        return `'${String(val).replace(/'/g, "''")}'`
      })
    } else {
      out[k] = v
    }
  }
  return out
}
