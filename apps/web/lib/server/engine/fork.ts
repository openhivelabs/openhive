/**
 * Fork pattern (S3) — Claude prompt-cache preserving parallel delegation.
 *
 * When `delegate_parallel` fans out to N claude-code children, each child's
 * first turn inherits the parent turn's **byte-identical** system prompt +
 * tools + history prefix. Anthropic's prompt-cache then serves siblings 2..N
 * from cache (≥ 70% cache_read_input_tokens), saving the N-1 fresh writes of
 * the 8–15K system+tools prefix.
 *
 * Mechanic (mirrors Claude Code's leaked `buildForkedMessages`):
 *   child.history = [
 *     ...parent.history.slice(0, lastAssistantIdx + 1),  // byte-identical ref
 *     { role: 'tool', tool_call_id: parentCallId, content: FORK_PLACEHOLDER },
 *     { role: 'user', content: FORK_BOILERPLATE + task },
 *   ]
 *
 * `<OPENHIVE_FORK_BOILERPLATE>` sentinel in the final user message is what
 * `isInForkChild` scans for — blocks recursive fork (fork-child spawning
 * grand-children via fork is denied, grand-children use fresh path).
 *
 * Spec: dev/active/runtime-claude-patterns/s3-fork-pattern.md
 */

import type { ChatMessage, ToolSpec } from '../providers/types'
import type { AgentSpec } from './team'

/** Verbatim string from Claude Code — the placeholder content for the parent's
 *  tool_use_id that fork children see in their synthetic tool_result block. */
export const FORK_PLACEHOLDER = 'Fork started — processing in background'

/** Opening sentinel of the boilerplate wrapper. `isInForkChild` scans the
 *  most-recent user message for this exact substring. */
export const FORK_BOILERPLATE_OPEN = '<OPENHIVE_FORK_BOILERPLATE>'
const FORK_BOILERPLATE_CLOSE = '</OPENHIVE_FORK_BOILERPLATE>'

/** In-memory snapshot of the parent's turn at the moment `streamTurn` enters
 *  the provider call. The parallel-delegation branch reads this to assemble
 *  children message arrays that are prefix-identical to the parent. */
export interface TurnSnapshot {
  /** `buildSystemPrompt(rounds)` — child's first turn uses this verbatim. */
  systemPrompt: string
  /** Parent `ChatMessage[]`. **Raw reference, not a copy** — children slice
   *  only up to the parent's lastAssistant at dispatch time. */
  history: ChatMessage[]
  /** `toolsToOpenAI(parentTools)` — children reuse the exact serialized tools. */
  tools: ToolSpec[]
  providerId: string
  model: string
  nodeId: string
  depth: number
  /** `Date.now()` — 60s TTL guard in `decideForkOrFresh`. */
  builtAt: number
}

/** Six-gate decision: one false → fresh path + `fork.skipped` event. */
export type ForkSkipReason =
  | 'env_disabled'
  | 'non_claude'
  | 'provider_mismatch'
  | 'no_snapshot'
  | 'recursive'

export interface ForkDecision {
  fork: boolean
  reason?: ForkSkipReason
  snapshot?: TurnSnapshot
}

/** Scan the most-recent user message for the fork boilerplate sentinel.
 *  Returns true iff the current context is already inside a fork-child
 *  — used to block recursive fork (grand-children go fresh path). */
export function isInForkChild(history: ChatMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (!m || m.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string') {
      return content.includes(FORK_BOILERPLATE_OPEN)
    }
    if (Array.isArray(content)) {
      for (const block of content as unknown as Array<Record<string, unknown>>) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          if ((block.text as string).includes(FORK_BOILERPLATE_OPEN)) return true
        }
      }
      return false
    }
    return false
  }
  return false
}

/**
 * Six-gate fork vs fresh decision (plan.md §2,택일 B):
 *   1. `OPENHIVE_FORK_DISABLE !== '1'`
 *   2. `child.provider_id === 'claude-code'`
 *   3. `snapshot.providerId === child.provider_id`   ← provider_mismatch gate
 *   4. `snapshot.nodeId === parent.id && snapshot.depth === depth`
 *   5. `Date.now() - snapshot.builtAt <= 60_000`
 *   6. `!isInForkChild(snapshot.history)`
 */
export function decideForkOrFresh(args: {
  snapshot: TurnSnapshot | undefined
  parent: AgentSpec
  child: AgentSpec
  depth: number
}): ForkDecision {
  if (process.env.OPENHIVE_FORK_DISABLE === '1') {
    return { fork: false, reason: 'env_disabled' }
  }
  if (args.child.provider_id !== 'claude-code') {
    return { fork: false, reason: 'non_claude' }
  }
  const snap = args.snapshot
  if (!snap) {
    return { fork: false, reason: 'no_snapshot' }
  }
  if (snap.providerId !== args.child.provider_id) {
    return { fork: false, reason: 'provider_mismatch' }
  }
  if (snap.nodeId !== args.parent.id || snap.depth !== args.depth) {
    return { fork: false, reason: 'no_snapshot' }
  }
  if (Date.now() - snap.builtAt > 60_000) {
    return { fork: false, reason: 'no_snapshot' }
  }
  if (isInForkChild(snap.history)) {
    return { fork: false, reason: 'recursive' }
  }
  return { fork: true, snapshot: snap }
}

/**
 * Build the child i's first-turn `ChatMessage[]`.
 *
 * The returned array:
 *   - Entries 0..lastAssistantIdx are **raw references** into
 *     `snapshot.history` (no copies — prefix must be byte-identical for cache).
 *   - The final two entries are newly-constructed: a `tool` role message with
 *     `FORK_PLACEHOLDER` answering the parent's `delegate_parallel` call, and
 *     a `user` message wrapping the fork directive + child's task.
 *
 * Throws if the parent's last message isn't `assistant + tool_calls` (defensive
 * — `runParallelDelegation` only fires after the Lead emitted a tool_use).
 */
export function buildForkedMessages(args: {
  snapshot: TurnSnapshot
  parentToolCallId: string
  siblingIndex: number
  siblingCount: number
  parentRole: string
  parentId: string
  childRole: string
  task: string
}): ChatMessage[] {
  const parentHistory = args.snapshot.history
  const lastIdx = parentHistory.length - 1
  const last = parentHistory[lastIdx]
  if (
    !last ||
    last.role !== 'assistant' ||
    !Array.isArray(last.tool_calls) ||
    last.tool_calls.length === 0
  ) {
    throw new Error('fork: parent last message is not assistant+tool_use')
  }

  const directive = `${FORK_BOILERPLATE_OPEN}\nYou are sibling ${args.siblingIndex + 1}/${args.siblingCount} of a delegate_parallel fan-out from ${args.parentRole}#${args.parentId} to ${args.childRole}. Your scope is below — do not duplicate siblings' work. Ignore orchestration tools above unless your task explicitly requires them.\n${FORK_BOILERPLATE_CLOSE}\n\n${args.task}`

  const toolResultMsg: ChatMessage = {
    role: 'tool',
    tool_call_id: args.parentToolCallId,
    content: FORK_PLACEHOLDER,
  }
  const synthUser: ChatMessage = {
    role: 'user',
    content: directive,
  }

  // Slice returns a new array, but entries are the same object references as
  // the parent — JSON.stringify output is byte-identical across siblings.
  const prefix = parentHistory.slice(0, lastIdx + 1)
  prefix.push(toolResultMsg, synthUser)
  return prefix
}
