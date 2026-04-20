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
import { callTool as mcpCallTool } from '../mcp/manager'
import { dataDir } from '../paths'
import { runQuery } from '../team-data'

const DEFAULT_TIMEOUT_MS = 30_000
const HTTP_MAX_BYTES = 2 * 1024 * 1024
const SELECT_RE = /^\s*(SELECT|WITH)\b/i

export class SourceError extends Error {}

export interface SourceSpec {
  kind: string
  config?: Record<string, unknown>
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

  switch (spec.kind) {
    case 'mcp':
      return execMcp(config)
    case 'team_data':
      return execTeamData(config, context)
    case 'http':
      return execHttp(config)
    case 'file':
      return execFile(config)
    case 'static':
      return config.value
    default:
      throw new SourceError(`unknown source kind: ${JSON.stringify(spec.kind)}`)
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
  const text = await withTimeout(
    mcpCallTool(server, tool, args as Record<string, unknown>),
    DEFAULT_TIMEOUT_MS,
    'mcp call',
  )
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
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
  if (!context.companySlug || !context.teamSlug) {
    throw new SourceError('team_data source needs company_slug + team_slug context')
  }
  return runQuery(context.companySlug, context.teamSlug, sql)
}

async function execHttp(config: Record<string, unknown>): Promise<unknown> {
  const url = String(config.url ?? '')
  if (!url) throw new SourceError('http source requires url')
  const method = String(config.method ?? 'GET').toUpperCase()
  const headers = config.headers
  if (headers && (typeof headers !== 'object' || Array.isArray(headers))) {
    throw new SourceError('http source headers must be an object')
  }
  const body = config.body
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(url, {
      method,
      headers: (headers as Record<string, string> | undefined) ?? undefined,
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
