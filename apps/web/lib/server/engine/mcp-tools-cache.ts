/**
 * Team-scoped cache for resolved MCP tool lists.
 *
 * Each runNode in a session used to call `mcpManager().getTools(server)` per
 * MCP server it was allowed to use. The manager already caches the raw
 * listTools result per proc, so RPCs weren't repeated — but every node still
 * paid the async hop plus rebuilt wrapped `Tool` objects. For a delegation
 * tree with N nodes and M servers, that was N*M wraps per run.
 *
 * This module memoises the resolved tool array by (team id | sorted server
 * names). Invalidation hooks are exposed for callers that know a team spec
 * or an MCP server has changed; without them the cache lives for the
 * process lifetime (same semantics as the proc cache).
 */

type ToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> }

type Entry = Promise<Array<{ serverName: string; tools: ToolInfo[]; error: string | null }>>

const g = globalThis as unknown as {
  __openhive_mcp_team_tool_cache?: Map<string, Entry>
}

function store(): Map<string, Entry> {
  if (!g.__openhive_mcp_team_tool_cache) {
    g.__openhive_mcp_team_tool_cache = new Map()
  }
  return g.__openhive_mcp_team_tool_cache
}

export function cacheKey(teamId: string, serverNames: readonly string[]): string {
  return `${teamId}|${[...serverNames].sort().join(',')}`
}

/** Fetch+wrap every MCP server's tools for a team-scope. If a server throws
 *  during listTools, we record the error inline (so the engine can surface a
 *  tool_result-style failure) without poisoning the cache with a rejected
 *  Promise — the promise itself resolves to a mixed success/error array. */
export function getTeamMcpTools(
  teamId: string,
  serverNames: readonly string[],
  fetchOne: (serverName: string) => Promise<ToolInfo[]>,
): Entry {
  const key = cacheKey(teamId, serverNames)
  const cached = store().get(key)
  if (cached) return cached
  const fresh = (async () => {
    const out: Array<{ serverName: string; tools: ToolInfo[]; error: string | null }> = []
    for (const serverName of serverNames) {
      try {
        const tools = await fetchOne(serverName)
        out.push({ serverName, tools, error: null })
      } catch (exc) {
        out.push({
          serverName,
          tools: [],
          error: exc instanceof Error ? exc.message : String(exc),
        })
      }
    }
    return out
  })()
  store().set(key, fresh)
  return fresh
}

/** Drop cached entries that mention `serverName`. Call this when an MCP
 *  server process has been restarted and its tool list may have shifted. */
export function invalidateServer(serverName: string): void {
  for (const key of [...store().keys()]) {
    const serversPart = key.split('|', 2)[1] ?? ''
    if (serversPart.split(',').includes(serverName)) {
      store().delete(key)
    }
  }
}

/** Drop every cached entry for a team. Call this when the team spec has
 *  been reloaded (allowed_mcp_servers may have changed). */
export function invalidateTeam(teamId: string): void {
  const prefix = `${teamId}|`
  for (const key of [...store().keys()]) {
    if (key.startsWith(prefix)) store().delete(key)
  }
}

/** Test-only: wipe the entire cache. */
export function __resetForTests(): void {
  store().clear()
}
