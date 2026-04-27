/**
 * Source executors. Ports apps/server/openhive/panels/sources.py.
 *
 * Five kinds:
 *   - mcp         call a tool on a configured MCP server
 *   - team_data   run a SELECT against the team's data.db
 *   - http        GET/POST a URL
 *   - file        read a UTF-8 file from ~/.openhive/
 *   - static      literal value (for AI-builder previews)
 */

import fs from 'node:fs'
import path from 'node:path'
import { getCredentialMeta, getCredentialValue } from '../credentials'
import { getServer as getMcpServer } from '../mcp/config'
import { callTool as mcpCallTool } from '../mcp/manager'
import { companyFilesDir, dataDir, teamDir } from '../paths'
import { runQuery } from '../team-data'

const DEFAULT_TIMEOUT_MS = 30_000
const HTTP_MAX_BYTES = 2 * 1024 * 1024
const SELECT_RE = /^\s*(SELECT|WITH)\b/i

export class SourceError extends Error {}

export interface SourceSpec {
  kind: string
  config?: Record<string, unknown>
  /** Optional credentials vault reference. Resolved here server-side so the
   *  raw secret never leaves the process. Applies to `http` / `http_recipe`
   *  today; MCP sources get their auth from the server process itself. */
  auth_ref?: string
}

export interface SourceContext {
  companySlug?: string
  teamSlug?: string
  teamId?: string
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SourceError(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return (await Promise.race([p, timeout])) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function execute(
  source: SourceSpec | unknown,
  context: SourceContext,
): Promise<unknown> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SourceError('source must be an object')
  }
  const spec = source as SourceSpec
  const config = spec.config && typeof spec.config === 'object' ? spec.config : {}
  if (Array.isArray(config)) {
    throw new SourceError('source.config must be an object')
  }

  // Pre-execute validation — surface actionable errors before the request is
  // dispatched so the panel shows a clear "you need to do X" message.
  validateSpec(spec, config)

  switch (spec.kind) {
    case 'mcp':
      return execMcp(config)
    case 'team_data':
      return execTeamData(config, context)
    case 'http':
      return execHttp(config, spec.auth_ref)
    case 'http_recipe':
      return execHttp(config, spec.auth_ref)
    case 'file':
      return execFile(config)
    case 'team_file':
      return execTeamFile(config, context)
    case 'company_file':
      return execCompanyFile(config, context)
    case 'static':
      return config.value
    default:
      throw new SourceError(`unknown source kind: ${JSON.stringify(spec.kind)}`)
  }
}

// -------- pre-execute validation --------

function validateSpec(spec: SourceSpec, config: Record<string, unknown>): void {
  // Credential presence — check vault *before* the HTTP call so the panel
  // renders a clear setup message instead of a 401 from the upstream.
  if (spec.auth_ref) {
    const meta = getCredentialMeta(spec.auth_ref)
    if (!meta) {
      throw new SourceError(
        `missing credential: "${spec.auth_ref}". Add it in Settings → Credentials.`,
      )
    }
  }

  // MCP server must exist in mcp.yaml before we try to call it.
  if (spec.kind === 'mcp') {
    const serverName = String(config.server ?? '')
    if (serverName && !getMcpServer(serverName)) {
      throw new SourceError(
        `MCP server "${serverName}" is not installed. Open Settings → MCP to add it.`,
      )
    }
  }
}

// -------- per-kind --------

async function execMcp(config: Record<string, unknown>): Promise<unknown> {
  const server = String(config.server ?? '')
  const tool = String(config.tool ?? '')
  const args = config.args
  if (!server || !tool) throw new SourceError('mcp source requires server + tool')
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new SourceError('mcp source args must be an object')
  }
  // Apply path is strictly read-only across every MCP server. The binder
  // could otherwise be talked into picking a mutating tool (apply_migration,
  // delete_branch, INSERT via execute_sql, …) and the user's real DB would
  // change every time a panel refreshes. Mutating in-app data lives on the
  // separate install/setup_sql path — never here.
  assertReadOnlyMcpCall(tool, args as Record<string, unknown>)
  const text = await withTimeout(
    mcpCallTool(server, tool, args as Record<string, unknown>, { cap: false }),
    DEFAULT_TIMEOUT_MS,
    'mcp call',
  )
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Allowlist of tool-name prefixes treated as read-only across MCP servers.
 *  Conservative: when in doubt, block. The Apply / preview / refresh path
 *  fires whatever binding the AI produced on every interval, so a single
 *  mutating call would compound. Setup/seed work runs on the install path
 *  with its own DDL whitelist; it never reaches here. */
const READ_ONLY_PREFIXES = [
  'list_',
  'search_',
  'get_',
  'fetch_',
  'read_',
  'describe_',
  'inspect_',
  'count_',
  'preview_',
  'lookup_',
  'find_',
  'show_',
  'view_',
  'select_',
]

/** Tools that look like SQL execution shells. We let them through only when
 *  the SQL itself parses as a single SELECT/WITH (same rule team_data SQL
 *  goes through). Any DDL/DML or stacked statements bounce. */
const SQL_TOOL_NAMES = new Set([
  'execute_sql',
  'run_sql',
  'run_query',
  'query',
  'sql',
  'pg_query',
  'mysql_query',
])

function assertReadOnlyMcpCall(
  tool: string,
  args: Record<string, unknown>,
): void {
  if (READ_ONLY_PREFIXES.some((p) => tool.startsWith(p))) return
  if (SQL_TOOL_NAMES.has(tool)) {
    const sql = String(
      (args.query ?? args.sql ?? args.statement ?? '') as unknown,
    ).trim()
    if (!sql) {
      throw new SourceError(
        `mcp tool ${JSON.stringify(tool)} called with empty SQL`,
      )
    }
    if (!SELECT_RE.test(sql)) {
      throw new SourceError(
        `mcp tool ${JSON.stringify(tool)} blocked: panel SQL must start with SELECT or WITH (read-only)`,
      )
    }
    // Reject stacked statements — single trailing `;` is fine, anything
    // after it is not. Comments stripped first so `;-- note` is allowed.
    const stripped = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const idx = stripped.indexOf(';')
    if (idx >= 0 && stripped.slice(idx + 1).trim().length > 0) {
      throw new SourceError(
        `mcp tool ${JSON.stringify(tool)} blocked: only a single SELECT/WITH statement is allowed`,
      )
    }
    return
  }
  throw new SourceError(
    `mcp tool ${JSON.stringify(tool)} blocked on the panel apply/refresh path: ` +
      `only read-only tools (list_*, get_*, search_*, describe_*, …) and SELECT-only execute_sql are allowed. ` +
      `Mutating data from a panel binding would change the user's real source on every refresh; ` +
      `seed/setup work belongs on the install path.`,
  )
}

async function execTeamData(
  config: Record<string, unknown>,
  context: SourceContext,
): Promise<unknown> {
  const sql = String(config.sql ?? '').trim()
  if (!sql) throw new SourceError('team_data source requires sql')
  if (!SELECT_RE.test(sql)) {
    throw new SourceError('team_data source allows only SELECT/WITH (read-only)')
  }
  if (!context.companySlug) {
    throw new SourceError('team_data source needs company_slug context')
  }
  // Auto-bind `:team_id` so panel SQL of the form
  //   SELECT … FROM customer WHERE team_id = :team_id
  // scopes to the installed team. Panels that omit the filter act as
  // company-wide views (opt-in cross-team).
  return runQuery(context.companySlug, sql, {
    teamId: context.teamId,
  })
}

async function execHttp(
  config: Record<string, unknown>,
  authRef: string | undefined,
): Promise<unknown> {
  const url = String(config.url ?? '')
  if (!url) throw new SourceError('http source requires url')
  const method = String(config.method ?? 'GET').toUpperCase()
  const headersRaw = config.headers
  if (headersRaw && (typeof headersRaw !== 'object' || Array.isArray(headersRaw))) {
    throw new SourceError('http source headers must be an object')
  }
  const headers: Record<string, string> = {
    ...((headersRaw as Record<string, string> | undefined) ?? {}),
  }
  // Resolve auth_ref → Authorization header. If the recipe opts into a custom
  // header name via `config.auth_header`, honor it. Default is
  // `Authorization: Bearer <value>`.
  if (authRef) {
    const value = getCredentialValue(authRef)
    if (!value) {
      throw new SourceError(`auth_ref "${authRef}" not found in credential vault`)
    }
    const authHeader = String(config.auth_header ?? 'Authorization')
    const authScheme = String(config.auth_scheme ?? 'Bearer')
    headers[authHeader] = authScheme ? `${authScheme} ${value}` : value
  }
  const body = config.body
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (exc) {
    throw new SourceError(
      `http error: ${exc instanceof Error ? exc.message : String(exc)}`,
    )
  } finally {
    clearTimeout(timer)
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new SourceError(`http ${resp.status}: ${body.slice(0, 300)}`)
  }
  const buf = await resp.arrayBuffer()
  const capped = buf.byteLength > HTTP_MAX_BYTES ? buf.slice(0, HTTP_MAX_BYTES) : buf
  const ctype = resp.headers.get('content-type') ?? ''
  const text = new TextDecoder('utf-8', { fatal: false }).decode(capped)
  if (ctype.toLowerCase().includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      /* fallthrough */
    }
  }
  return text
}

/**
 * team_file — sandboxed to this team's `files/` directory. Reads a single file
 * with optional format parsing. AI composer uses this for "today's notes.md",
 * uploaded CSV fixtures, etc.
 */
function execTeamFile(
  config: Record<string, unknown>,
  context: SourceContext,
): unknown {
  const rel = String(config.path ?? '')
  if (!rel) throw new SourceError('team_file source requires path')
  if (!context.companySlug || !context.teamSlug) {
    throw new SourceError('team_file source needs company_slug + team_slug context')
  }
  const base = path.resolve(teamDir(context.companySlug, context.teamSlug), 'files')
  const candidate = path.resolve(base, rel)
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    throw new SourceError(`team_file path escapes team files dir: ${JSON.stringify(rel)}`)
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new SourceError(`file not found: ${JSON.stringify(rel)}`)
  }
  const text = fs.readFileSync(candidate, 'utf8')
  const format = String(config.format ?? inferFormat(candidate)).toLowerCase()
  switch (format) {
    case 'json':
      try {
        return JSON.parse(text)
      } catch (e) {
        throw new SourceError(`json parse: ${e instanceof Error ? e.message : String(e)}`)
      }
    case 'csv':
      return parseCsv(text)
    case 'markdown':
    case 'md':
      return parseMarkdown(text)
    default:
      return text
  }
}

/**
 * company_file — sandboxed to the *company* `files/` directory (shared by
 * every team). Mirrors {@link execTeamFile} otherwise. Use this for
 * reference data the whole company should see the same way (org chart,
 * product catalog, policies).
 */
function execCompanyFile(
  config: Record<string, unknown>,
  context: SourceContext,
): unknown {
  const rel = String(config.path ?? '')
  if (!rel) throw new SourceError('company_file source requires path')
  if (!context.companySlug) {
    throw new SourceError('company_file source needs company_slug context')
  }
  const base = path.resolve(companyFilesDir(context.companySlug))
  const candidate = path.resolve(base, rel)
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    throw new SourceError(`company_file path escapes company files dir: ${JSON.stringify(rel)}`)
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new SourceError(`file not found: ${JSON.stringify(rel)}`)
  }
  const text = fs.readFileSync(candidate, 'utf8')
  const format = String(config.format ?? inferFormat(candidate)).toLowerCase()
  switch (format) {
    case 'json':
      try {
        return JSON.parse(text)
      } catch (e) {
        throw new SourceError(`json parse: ${e instanceof Error ? e.message : String(e)}`)
      }
    case 'csv':
      return parseCsv(text)
    case 'markdown':
    case 'md':
      return parseMarkdown(text)
    default:
      return text
  }
}

function inferFormat(p: string): string {
  const ext = path.extname(p).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.csv') return 'csv'
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  return 'text'
}

/** Minimal RFC-4180 CSV parser — handles quoted fields with commas/newlines
 *  and doubled-quote escapes. Good enough for dashboard fixtures; not a full
 *  CSV library. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) return []
  const headers = rows[0] as string[]
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => {
      obj[h] = r[idx] ?? ''
    })
    return obj
  })
}

/** Split YAML-style frontmatter (if present) and return `{frontmatter, body}`.
 *  Frontmatter parsing is deliberately shallow — just `key: value` lines. */
function parseMarkdown(text: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {}
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 4)
    if (end !== -1) {
      const header = text.slice(4, end)
      for (const line of header.split('\n')) {
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
        if (m) frontmatter[m[1] as string] = (m[2] as string).trim()
      }
      return { frontmatter, body: text.slice(end + 5) }
    }
  }
  return { frontmatter, body: text }
}

/** List files under this team's `files/` directory. Used by the catalog. */
export function listTeamFiles(companySlug: string, teamSlug: string): string[] {
  const base = path.resolve(teamDir(companySlug, teamSlug), 'files')
  if (!fs.existsSync(base)) return []
  const out: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  walk(base, '')
  return out.sort()
}

function execFile(config: Record<string, unknown>): unknown {
  const pathStr = String(config.path ?? '')
  if (!pathStr) throw new SourceError('file source requires path')
  const base = path.resolve(dataDir())
  const candidate = path.resolve(base, pathStr)
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    throw new SourceError(`file path escapes data_dir: ${JSON.stringify(pathStr)}`)
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new SourceError(`file not found: ${JSON.stringify(pathStr)}`)
  }
  const text = fs.readFileSync(candidate, 'utf8')
  if (path.extname(candidate).toLowerCase() === '.json') {
    try {
      return JSON.parse(text)
    } catch {
      /* fallthrough */
    }
  }
  return text
}
