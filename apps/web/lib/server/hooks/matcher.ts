/**
 * Glob → RegExp for hook matcher fields. MVP uses `*` and `?` only, Claude
 * Code style. No new npm dep (CLAUDE.md).
 *
 * PreToolUse matchers compare against tool_name (e.g. `sql_*`, `mcp__brave__*`).
 * SessionStart / Stop matchers compare against company_id (or "" for ad-hoc).
 */

import type { HookEntry, HookEventName } from './types'

const GLOB_CACHE = new Map<string, RegExp>()

export function globToRegex(glob: string): RegExp {
  const cached = GLOB_CACHE.get(glob)
  if (cached) return cached
  // Escape regex special chars except `*` / `?`, then expand.
  let re = ''
  for (const ch of glob) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += `\\${ch}`
    else re += ch
  }
  const compiled = new RegExp(`^${re}$`)
  GLOB_CACHE.set(glob, compiled)
  return compiled
}

export function matchesGlob(glob: string, target: string): boolean {
  return globToRegex(glob).test(target)
}

export function matchHooks(
  _event: HookEventName,
  target: string,
  entries: HookEntry[],
): HookEntry[] {
  if (entries.length === 0) return entries
  return entries.filter((e) => matchesGlob(e.matcher, target))
}
