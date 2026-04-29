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
 *   - A3 placeholder: when the cleared envelope carried artifact refs
 *     (files[]), the stub embeds a multi-line `Artifacts:` block with
 *     `artifact://` URIs so the LLM can `read_artifact({path})` later.
 *
 * The v1 trigger is time-only. A4's token-based `shouldMicrocompact` will
 * be ANDed in at v2 (plan §4.1, S2 spec §ADDENDUM).
 */

import type { ChatMessage } from '../providers/types'
import { buildArtifactUri } from '../sessions/artifacts'

export const STALE_AFTER_MS = (() => {
  const raw = process.env.OPENHIVE_MICROCOMPACT_STALE_MS
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000
})()

const MICROCOMPACT_DISABLED = process.env.OPENHIVE_MICROCOMPACT_DISABLED === '1'

const MICROCOMPACT_MIN_CHARS = (() => {
  const raw = process.env.OPENHIVE_MICROCOMPACT_MIN_CHARS
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : 200
})()

/** Read-only built-in tools safe to clear. `read_artifact` is included
 *  (A3) — its output is a snapshot of a session-local file; if the LLM
 *  needs the content again it can just call the tool again. */
const COMPACTABLE_BUILTIN = new Set<string>([
  // Typed skills (kebab-case): read-only networked calls whose bodies bloat
  // history; safe to compact because the skill re-runs cheaply with cache.
  'web-fetch',
  'web-search',
  // DB read tools: re-run cheaply against the per-team SQLite.
  'db_describe',
  'db_query',
  'db_explain',
  'db_read_guide',
  'read_skill_file',
  'run_skill_script', // special-cased below — files[] preserved
  'read_artifact',
  // Panel/dashboard read tools — snapshots of dashboard.yaml or cache rows.
  'panel_list',
  'panel_get',
  'panel_market_list',
  'panel_get_data',
  'panel_refresh',
  'dashboard_list_backups',
])

/** Trajectory-encoding / audit-critical tools. Never compact. */
const NEVER_COMPACT = new Set<string>([
  'delegate_to',
  'delegate_parallel',
  'ask_user',
  'set_todos',
  'add_todo',
  'complete_todo',
  'db_exec',
  'db_install_template',
  'activate_skill',
  // Panel/dashboard mutations: install/update/delete/execute_action all
  // change persistent state the LLM may need to reference later (e.g. the
  // panel id returned by panel_install must survive into a follow-up
  // panel_update_binding call).
  'panel_install',
  'panel_update_binding',
  'panel_set_position',
  'panel_set_props',
  'panel_delete',
  'panel_execute_action',
  'dashboard_restore_backup',
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

interface MicrocompactEntry {
  tool_name: string
  tool_call_id: string
  original_chars: number
}

interface MicrocompactResult {
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
    files: p.files, // A3: each entry carries `uri` — addressable via read_artifact
    _cleared: `stdout/stderr cleared (${content.length} chars). Use read_artifact({path: "..."}) to re-read individual files; re-run the script if you need fresh output.`,
  })
}

/** A3: extract artifact references from a tool_result envelope for
 *  embedding in the generic placeholder. Looks for `files: [...]` and
 *  pulls out `{name, uri}` pairs. Best-effort — returns [] if the
 *  content isn't a structured envelope. */
interface ArtifactRef {
  name: string
  uri: string
}

function extractArtifactRefs(content: string, sessionId: string): ArtifactRef[] {
  if (typeof content !== 'string') return []
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.files)) return []
  const refs: ArtifactRef[] = []
  for (const c of obj.files) {
    if (!c || typeof c !== 'object') continue
    const entry = c as Record<string, unknown>
    const name =
      (typeof entry.filename === 'string' && entry.filename) ||
      (typeof entry.name === 'string' && entry.name) ||
      null
    if (!name) continue
    const uriField = typeof entry.uri === 'string' ? entry.uri : null
    const absPath = typeof entry.path === 'string' ? entry.path : null
    const uri = uriField
      ? uriField
      : absPath
        ? buildArtifactUri(sessionId, absPath)
        : `artifact://session/${sessionId}/artifacts/${name}`
    refs.push({ name, uri })
  }
  return refs
}

/** A3: build the generic in-place placeholder for a cleared tool_result.
 *  Prefers a multi-line `Artifacts:` block when the envelope carried
 *  artifact refs so the LLM can hit `read_artifact({path: "..."})` on the
 *  exact URI. Falls back to a terse single-line stub otherwise. */
function buildGenericStub(toolName: string, original: string, sessionId: string): string {
  const refs = extractArtifactRefs(original, sessionId)
  if (refs.length === 0) {
    return `${CLEARED_PREFIX}. Tool: ${toolName}. Re-call if needed.]`
  }
  const lines = refs.map((r) => `  - ${r.name} (${r.uri})`).join('\n')
  return [
    `${CLEARED_PREFIX}. Tool: ${toolName}.`,
    'Artifacts:',
    lines,
    'Re-read via read_artifact({path: "..."}).]',
  ].join('\n')
}

/**
 * In-place clear stale tool_result bodies. Returns a summary for the
 * caller to emit as `microcompact.applied` events.
 *
 * @param history    Lead's externalHistory. Mutated in place.
 * @param sessionId  Current session id. Used by A3 to build `artifact://`
 *                   URIs inside placeholder stubs so the LLM can call
 *                   `read_artifact` to rehydrate cleared envelopes.
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
      if (special !== null) {
        replacement = special
      } else {
        // Not a structured envelope — fall back to generic clear.
        replacement = buildGenericStub(toolName, original, sessionId)
      }
    } else {
      replacement = buildGenericStub(toolName, original, sessionId)
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
