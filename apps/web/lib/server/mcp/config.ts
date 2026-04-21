/**
 * User-installed MCP server config persistence (~/.openhive/mcp.yaml).
 * Ports apps/server/openhive/mcp/config.py.
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { mcpConfigPath } from '../paths'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/

export interface ServerConfig extends Record<string, unknown> {
  command: string
  args: string[]
  env: Record<string, string>
  preset_id?: string
}

function loadRaw(): { servers: Record<string, ServerConfig> } {
  const p = mcpConfigPath()
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return { servers: {} }
  }
  let raw: unknown
  try {
    raw = yaml.load(fs.readFileSync(p, 'utf8'))
  } catch {
    return { servers: {} }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { servers: {} }
  }
  const data = raw as { servers?: unknown }
  if (!data.servers || typeof data.servers !== 'object' || Array.isArray(data.servers)) {
    return { servers: {} }
  }
  return { servers: data.servers as Record<string, ServerConfig> }
}

function saveRaw(data: { servers: Record<string, ServerConfig> }): void {
  const p = mcpConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(
    tmp,
    yaml.dump(data, { noRefs: true, sortKeys: false }),
    'utf8',
  )
  fs.renameSync(tmp, p)
}

export function listServers(): Record<string, ServerConfig> {
  return loadRaw().servers
}

export function getServer(name: string): ServerConfig | null {
  return loadRaw().servers[name] ?? null
}

export function upsertServer(name: string, server: Partial<ServerConfig>): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid server name ${JSON.stringify(name)} — use 2-32 lowercase alphanum chars, hyphens, underscores`,
    )
  }
  if (!server.command) {
    throw new Error("server config must include 'command'")
  }
  const full: ServerConfig = {
    command: String(server.command),
    args: Array.isArray(server.args) ? server.args.map(String) : [],
    env: server.env && typeof server.env === 'object' && !Array.isArray(server.env)
      ? Object.fromEntries(
          Object.entries(server.env).map(([k, v]) => [k, String(v)]),
        )
      : {},
    ...(server.preset_id ? { preset_id: String(server.preset_id) } : {}),
  }
  const data = loadRaw()
  data.servers[name] = full
  saveRaw(data)
}

export function deleteServer(name: string): boolean {
  const data = loadRaw()
  if (!(name in data.servers)) return false
  delete data.servers[name]
  saveRaw(data)
  return true
}
