/**
 * MCP server process manager — lazy spawn + lifetime keepalive.
 * Ports apps/server/openhive/mcp/manager.py.
 *
 * Each user-installed MCP server gets a long-lived stdio subprocess + Client
 * session. First reference triggers spawn; the process stays alive until
 * shutdown or explicit restart. Reusing the session saves the 2–5s npx
 * bootstrap on every tool call.
 *
 * State lives on globalThis so HMR doesn't orphan child processes.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as mcpConfig from './config'

const SPAWN_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 60_000
const MCP_RESULT_MAX_CHARS = 20_000

interface ToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface Proc {
  name: string
  client: Client | null
  transport: StdioClientTransport | null
  toolsCache: ToolInfo[] | null
  lastError: string | null
  /** Serialises start attempts so concurrent callers wait on one spawn. */
  startLock: Promise<void> | null
}

interface ManagerState {
  procs: Map<string, Proc>
}

const globalForManager = globalThis as unknown as {
  __openhive_mcp_manager_state?: ManagerState
}

function state(): ManagerState {
  if (!globalForManager.__openhive_mcp_manager_state) {
    globalForManager.__openhive_mcp_manager_state = { procs: new Map() }
  }
  return globalForManager.__openhive_mcp_manager_state
}

function ensureProc(name: string): Proc {
  const s = state()
  let proc = s.procs.get(name)
  if (!proc) {
    proc = {
      name,
      client: null,
      transport: null,
      toolsCache: null,
      lastError: null,
      startLock: null,
    }
    s.procs.set(name, proc)
  }
  return proc
}

function buildTransport(server: mcpConfig.ServerConfig): StdioClientTransport {
  return new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: Object.keys(server.env ?? {}).length > 0 ? server.env : undefined,
  })
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return (await Promise.race([p, timeout])) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function startClient(server: mcpConfig.ServerConfig): Promise<{
  client: Client
  transport: StdioClientTransport
}> {
  const transport = buildTransport(server)
  const client = new Client(
    { name: 'openhive', version: '0.1.0' },
    { capabilities: {} },
  )
  await withTimeout(client.connect(transport), SPAWN_TIMEOUT_MS, 'mcp connect')
  return { client, transport }
}

async function ensureStarted(name: string, server: mcpConfig.ServerConfig): Promise<Proc> {
  const proc = ensureProc(name)
  if (proc.client) return proc
  if (proc.startLock) {
    await proc.startLock
    if (proc.client) return proc
  }
  const lock = (async () => {
    try {
      const { client, transport } = await startClient(server)
      proc.client = client
      proc.transport = transport
      proc.lastError = null
      proc.toolsCache = null
    } catch (exc) {
      proc.lastError = exc instanceof Error ? exc.message : String(exc)
      throw exc
    }
  })()
  proc.startLock = lock
  try {
    await lock
  } finally {
    proc.startLock = null
  }
  return proc
}

async function listCachedTools(proc: Proc): Promise<ToolInfo[]> {
  if (proc.toolsCache) return proc.toolsCache
  if (!proc.client) return []
  const res = await proc.client.listTools()
  proc.toolsCache = (res.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema:
      (t.inputSchema as Record<string, unknown> | undefined) ?? {
        type: 'object',
        properties: {},
      },
  }))
  return proc.toolsCache
}

export async function getTools(name: string): Promise<ToolInfo[]> {
  const server = mcpConfig.getServer(name)
  if (!server) throw new Error(`MCP server not configured: ${JSON.stringify(name)}`)
  const proc = await ensureStarted(name, server)
  return listCachedTools(proc)
}

export async function callTool(
  name: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = mcpConfig.getServer(name)
  if (!server) throw new Error(`MCP server not configured: ${JSON.stringify(name)}`)
  const proc = await ensureStarted(name, server)
  if (!proc.client) throw new Error(`MCP server not running: ${JSON.stringify(name)}`)
  const result = await withTimeout(
    proc.client.callTool({ name: toolName, arguments: args }),
    CALL_TIMEOUT_MS,
    `mcp ${name}__${toolName}`,
  )
  const pieces: string[] = []
  const content = (result as { content?: unknown[] }).content ?? []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') pieces.push(text)
    else pieces.push(JSON.stringify(block))
  }
  const body = pieces.join('\n')
  const capped = capMcpBody(body)
  if ((result as { isError?: boolean }).isError) {
    return `ERROR from ${name}__${toolName}: ${capped || 'unknown error'}`
  }
  return capped
}

export function capMcpBody(body: string): string {
  if (body.length <= MCP_RESULT_MAX_CHARS) return body
  const head = body.slice(0, MCP_RESULT_MAX_CHARS)
  return (
    `${head}\n\n[openhive:mcp-truncated] Response was ${body.length} chars; ` +
    `showing first ${MCP_RESULT_MAX_CHARS}. Narrow the query ` +
    `(pagination, filter, search term) and call again if more is needed.`
  )
}

export async function restart(name: string): Promise<void> {
  const proc = state().procs.get(name)
  if (!proc) return
  if (proc.transport) {
    try {
      await proc.transport.close()
    } catch {
      /* ignore */
    }
  }
  if (proc.client) {
    try {
      await proc.client.close()
    } catch {
      /* ignore */
    }
  }
  proc.client = null
  proc.transport = null
  proc.toolsCache = null
  proc.lastError = null
  state().procs.delete(name)
}

export async function shutdownAll(): Promise<void> {
  const names = [...state().procs.keys()]
  await Promise.allSettled(names.map(restart))
}

export interface StatusSnapshot {
  running: boolean
  last_error: string | null
  tool_count: number | null
}

export function statusSnapshot(): Record<string, StatusSnapshot> {
  const out: Record<string, StatusSnapshot> = {}
  for (const [name, proc] of state().procs) {
    out[name] = {
      running: proc.client !== null,
      last_error: proc.lastError,
      tool_count: proc.toolsCache ? proc.toolsCache.length : null,
    }
  }
  return out
}

// -------- ephemeral test connection --------

export async function testConnection(
  server: mcpConfig.ServerConfig,
): Promise<{ ok: boolean; tools?: { name: string; description: string }[]; error?: string }> {
  const transport = buildTransport(server)
  const client = new Client(
    { name: 'openhive-test', version: '0.1.0' },
    { capabilities: {} },
  )
  try {
    await withTimeout(client.connect(transport), SPAWN_TIMEOUT_MS, 'mcp connect')
    const res = await withTimeout(
      client.listTools(),
      SPAWN_TIMEOUT_MS,
      'mcp list_tools',
    )
    const tools = (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
    }))
    return { ok: true, tools }
  } catch (exc) {
    return { ok: false, error: exc instanceof Error ? exc.message : String(exc) }
  } finally {
    try {
      await transport.close()
    } catch {
      /* ignore */
    }
    try {
      await client.close()
    } catch {
      /* ignore */
    }
  }
}

