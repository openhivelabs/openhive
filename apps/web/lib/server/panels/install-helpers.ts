/**
 * Helpers shared between the HTTP install handler (server/api/market.ts) and
 * chat-callable installer wrappers (./installer.ts). Pure utility — no
 * stateful server context.
 */

import { fetchMarketFrame } from '../market'

/** Naive top-level `;` split. Fine for our seed DDL (no string literals
 *  inside CREATE TABLEs). Trims and drops empty chunks. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Detect whether a CREATE TABLE statement targets a name in `skipNames`.
 *  Used to avoid recreating tables when a panel install reuses existing
 *  tables (decision='reuse'). Returns false if the SQL isn't a CREATE TABLE. */
export function shouldSkipCreate(stmt: string, skipNames: Set<string>): boolean {
  if (skipNames.size === 0) return false
  const m = stmt.match(
    /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/i,
  )
  if (!m) return false
  return skipNames.has(m[1]!)
}

/** Fetch a panel frame from the market and extract its three install-relevant
 *  parts: optional setup_sql, the frame's `panel` body (deep-cloned so callers
 *  may mutate freely), and an optional human description. */
export async function fetchPanelFrameParts(
  id: string,
  category: string | undefined,
): Promise<{
  setupSql: string | undefined
  panel: Record<string, unknown>
  description: string | undefined
}> {
  if (!category) throw new Error('category required for panel install')
  const frame = (await fetchMarketFrame('panel', id, category)) as
    | Record<string, unknown>
    | null
  if (!frame || typeof frame !== 'object') {
    throw new Error('invalid panel frame')
  }
  const panelRaw = (frame as { panel?: unknown }).panel ?? frame
  if (!panelRaw || typeof panelRaw !== 'object') {
    throw new Error('panel frame missing `panel` body')
  }
  const setupSqlVal = (frame as { setup_sql?: unknown }).setup_sql
  const setupSql =
    typeof setupSqlVal === 'string' && setupSqlVal.trim() ? setupSqlVal : undefined
  const descVal =
    (frame as { description?: unknown }).description ??
    (panelRaw as { description?: unknown }).description
  const description = typeof descVal === 'string' ? descVal : undefined
  return {
    setupSql,
    panel: JSON.parse(JSON.stringify(panelRaw)) as Record<string, unknown>,
    description,
  }
}

/** Generate a fresh panel id in the format used by the existing install
 *  handler: `p-` + base36 random + base36 timestamp tail. */
export function newPanelId(): string {
  return `p-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
}

/** Clamp an optional grid-span value into the supported [1, 6] range. */
export function clampSpan(v: number | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(6, Math.max(1, Math.floor(v)))
}
