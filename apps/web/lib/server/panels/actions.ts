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

import { withTeamDb } from '../team-data'
import { callTool as mcpCallTool } from '../mcp/manager'
import { getCredentialValue } from '../credentials'
import { logPanelAction } from './audit'
import { deleteCache } from './cache'

export interface ActionContext {
  companySlug: string
  teamSlug: string
  teamId: string
}

export interface FormFieldSpec {
  name: string
  label?: string
  type?: string
  required?: boolean
  options?: string[]
  min?: number
  max?: number
  default?: unknown
}

export interface FormSchemaSpec {
  fields?: FormFieldSpec[]
}

export interface ActionTargetSpec {
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

export function validateValues(
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
      if (field.options && !field.options.includes(String(raw))) {
        throw new ActionError(
          `field "${field.name}" must be one of ${field.options.join(', ')}`,
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
        result = await execMcpAction(action, values)
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
  // Collect all :name references in the SQL. Fill missing params with null so
  // optional form fields (e.g. an empty date) insert as NULL instead of
  // crashing the statement.
  const paramNames = Array.from(sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)).map(
    (m) => m[1] as string,
  )
  const bound: Record<string, unknown> = {}
  for (const n of paramNames) {
    const v = values[n]
    bound[n] = v === undefined || v === '' ? null : v
  }
  return withTeamDb(ctx.companySlug, ctx.teamSlug, (conn) => {
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
  const template = action.target.config?.args_template
  const args =
    template && typeof template === 'object' && !Array.isArray(template)
      ? renderTemplate(template as Record<string, unknown>, values)
      : values
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
