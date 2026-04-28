/**
 * MCP whitelist loader — reads `packages/mcp-presets/registry.yaml` (shipped
 * in the repo) and merges with `~/.openhive/mcp/registry.yaml` for per-user
 * additions. The curated list drives the "Integrations" settings page and
 * steers the AI composer toward supported servers.
 *
 * The file here is *metadata only* — actual MCP process lifecycle stays in
 * `lib/server/mcp/manager.ts`. This module answers questions like "which
 * servers are supported" and "which auth flow to run on connect".
 */

import path from 'node:path'
import { dataDir, packagesRoot } from './paths'
import { readYamlCached } from './yaml-io'

export type McpAuthKind =
  | 'oauth_google'
  | 'oauth_slack'
  | 'oauth_notion'
  | 'oauth_github'
  | 'oauth_linear'
  | 'oauth_hubspot'
  | 'api_key'
  | 'none'

export interface McpRegistryEntry {
  id: string
  label: string
  icon?: string
  category?: string
  package: string
  auth: McpAuthKind
  description?: string
  recipes?: string[]
}

interface RegistryFile {
  servers?: McpRegistryEntry[]
}

function readYaml(p: string): RegistryFile | null {
  // Hot path on the Settings page — readYamlCached avoids re-parsing the
  // bundled + user registry yaml on every request via mtime check.
  return (readYamlCached(p) as unknown as RegistryFile | null) ?? null
}

export function listMcpRegistry(): McpRegistryEntry[] {
  const bundled = readYaml(path.join(packagesRoot(), 'mcp-presets', 'registry.yaml'))
  const user = readYaml(path.join(dataDir(), 'mcp', 'registry.yaml'))
  const out = new Map<string, McpRegistryEntry>()
  for (const entry of bundled?.servers ?? []) {
    if (entry && typeof entry.id === 'string') out.set(entry.id, entry)
  }
  // User overrides take precedence on id collision.
  for (const entry of user?.servers ?? []) {
    if (entry && typeof entry.id === 'string') out.set(entry.id, entry)
  }
  return Array.from(out.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function getMcpRegistryEntry(id: string): McpRegistryEntry | null {
  return listMcpRegistry().find((e) => e.id === id) ?? null
}
