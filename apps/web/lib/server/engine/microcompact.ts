/**
 * Time-based microcompact: clear stale tool_result bodies in-place when the
 * provider's prefix cache is (necessarily) already cold.
 *
 * Ported from Claude Code's `services/compact/microCompact.ts` time-based
 * path, adapted to OpenHive's OpenAI-shaped ChatMessage model.
 *
 *   - Trigger: last assistant message's `_ts` is older than STALE_AFTER_MS
 *     (default 5min — matches Anthropic ephemeral cache TTL). If cache is
 *     still hot we do nothing: mutating history would force a cold re-read
 *     on the next turn.
 *   - Whitelist: only read-only external snapshots (web_fetch, sql_query,
 *     read_skill_file, run_skill_script, all mcp__* tools) are compactable.
 *     Trajectory-carrying tools (delegate_to, ask_user, TODOs, sql_exec,
 *     activate_skill) are never touched — the LLM needs them to reconstruct
 *     what happened.
 *   - Lead only: caller (streamTurn) gates on `depth === 0`; sub-agent
 *     histories are short and ephemeral, ROI is ~0.
 *   - Idempotent: already-cleared results are skipped on subsequent passes.
 *   - In-memory only: no FS persistence. events.jsonl records the fact as
 *     `microcompact.applied` for observability.
 *
 * The v1 trigger is time-only. A4's token-based `shouldMicrocompact` will
 * be ANDed in at v2 (plan §4.1, S2 spec §ADDENDUM).
 */

import type { ChatMessage } from '../providers/types'

export const STALE_AFTER_MS = (() => {
  const raw = process.env.OPENHIVE_MICROCOMPACT_STALE_MS
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000
})()

export const MICROCOMPACT_DISABLED = process.env.OPENHIVE_MICROCOMPACT_DISABLED === '1'

export const MICROCOMPACT_MIN_CHARS = (() => {
  const raw = process.env.OPENHIVE_MICROCOMPACT_MIN_CHARS
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : 200
})()

/** Read-only built-in tools safe to clear. `read_artifact` will be added
 *  when A3 lands (ADDENDUM item 3). */
export const COMPACTABLE_BUILTIN = new Set<string>([
  'web_fetch',
  'sql_query',
  'read_skill_file',
  'run_skill_script', // special-cased below — files[] preserved
])

/** Trajectory-encoding / audit-critical tools. Never compact. */
export const NEVER_COMPACT = new Set<string>([
  'delegate_to',
  'delegate_parallel',
  'ask_user',
  'set_todos',
  'add_todo',
  'complete_todo',
  'sql_exec',
  'activate_skill',
])

export function isCompactable(name: string): boolean {
  if (NEVER_COMPACT.has(name)) return false
  if (COMPACTABLE_BUILTIN.has(name)) return true
  // MCP tools use `${serverName}__${toolName}` (session.ts mcpTool). All
  // external snapshots from our POV — default compactable. Specific MCP
  // writes that mutate remote state (e.g. notion-create-pages) can be
  // added to NEVER_COMPACT individually if they surface as issues.
  if (name.includes('__')) return true
  return false
}

const CLEARED_PREFIX = '[Old tool result cleared'

export interface MicrocompactEntry {
  tool_name: string
  tool_call_id: string
  original_chars: number
}

export interface MicrocompactResult {
  applied: number
  charsSaved: number
  entries: MicrocompactEntry[]
}

/** Build `tool_call_id → tool_name` map from assistant messages. Mirrors
 *  session.ts `indexToolCalls` but kept local so this module has no
 *  cyclic import back into session.ts. */
function indexToolCalls(history: ChatMessage[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of history) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls) {
      if (tc.id && tc.function?.name) out.set(tc.id, tc.function.name)
    }
  }
  return out
}

/** Find the newest assistant `_ts` in history. Returns 0 if none found —
 *  legacy / reattached history has no timestamps, so we treat it as
 *  "stale" and compact conservatively. Safe: the worst case is a single
 *  extra cache miss right after reattach. */
function lastAssistantTs(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m && m.role === 'assistant' && typeof m._ts === 'number') {
      return m._ts
    }
  }
  return 0
}

/** Special-case `run_skill_script`: the JSON envelope's `files: [...]`
 *  array is referenced by later turns (artifact pointers from
 *  registerSkillArtifacts). Preserve files, clear stdout/stderr. */
function compactRunSkillScript(content: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null // not a valid envelope — caller falls back to generic clear
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (!Array.isArray(p.files)) return null
  return JSON.stringify({
    ok: p.ok,
    files: p.files,
    _cleared: `stdout/stderr cleared (${content.length} chars). Re-run if needed.`,
  })
}

/** Extract a short CSV of file names from any envelope that carries a
 *  `files: [{name: string}]` array, so the generic placeholder can still
 *  hint at what was produced. Best-effort; returns '' if shape doesn't
 *  match. */
function extractFileNamesIfAny(content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return ''
  }
  if (!parsed || typeof parsed !== 'object') return ''
  const files = (parsed as Record<string, unknown>).files
  if (!Array.isArray(files)) return ''
  const names: string[] = []
  for (const f of files) {
    if (f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string') {
      names.push((f as { name: string }).name)
    }
  }
  return names.join(', ')
}

/**
 * In-place clear stale tool_result bodies. Returns a summary for the
 * caller to emit as `microcompact.applied` events.
 *
 * @param history    Lead's externalHistory. Mutated in place.
 * @param sessionId  Current session id. Reserved for A3 placeholder
 *                   formatting (artifact URIs); unused in v1.
 * @param now        Injected clock for tests. Defaults to Date.now().
 */
export function maybeMicrocompact(
  history: ChatMessage[],
  sessionId: string,
  now: number = Date.now(),
): MicrocompactResult {
  const empty: MicrocompactResult = { applied: 0, charsSaved: 0, entries: [] }
  if (MICROCOMPACT_DISABLED) return empty
  if (history.length === 0) return empty
  // sessionId intentionally unused in v1 — reserved for A3 placeholder URIs.
  void sessionId

  const lastTs = lastAssistantTs(history)
  const age = now - lastTs
  if (lastTs > 0 && age < STALE_AFTER_MS) {
    // Cache still hot — do NOT mutate. The cost of a cache miss on the
    // next turn exceeds whatever we'd save by clearing bodies now.
    return empty
  }

  const meta = indexToolCalls(history)
  const entries: MicrocompactEntry[] = []
  let applied = 0
  let charsSaved = 0

  for (const m of history) {
    if (m.role !== 'tool') continue
    if (typeof m.content !== 'string') continue
    const original = m.content
    if (original.length < MICROCOMPACT_MIN_CHARS) continue
    if (original.startsWith(CLEARED_PREFIX)) continue // idempotent
    const toolCallId = m.tool_call_id ?? ''
    const toolName = meta.get(toolCallId) ?? ''
    if (!toolName || !isCompactable(toolName)) continue

    let replacement: string
    if (toolName === 'run_skill_script') {
      const special = compactRunSkillScript(original)
      if (special === null) {
        // Not a structured envelope — fall back to generic clear.
        const filesCsv = extractFileNamesIfAny(original)
        replacement = `${CLEARED_PREFIX}. Tool: ${toolName}.${
          filesCsv ? ` Files: ${filesCsv}.` : ''
        } Re-call if needed.]`
      } else {
        replacement = special
      }
    } else {
      const filesCsv = extractFileNamesIfAny(original)
      replacement = `${CLEARED_PREFIX}. Tool: ${toolName}.${
        filesCsv ? ` Files: ${filesCsv}.` : ''
      } Re-call if needed.]`
    }

    if (replacement.length >= original.length) {
      // Wouldn't save anything — skip so we don't grow the prompt.
      continue
    }

    m.content = replacement
    entries.push({
      tool_name: toolName,
      tool_call_id: toolCallId,
      original_chars: original.length,
    })
    applied += 1
    charsSaved += original.length - replacement.length
  }

  return { applied, charsSaved, entries }
}
