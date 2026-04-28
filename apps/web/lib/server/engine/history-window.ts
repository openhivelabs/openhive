/**
 * History sliding-window compaction.
 *
 * OpenHive users accept higher token spend, so the default window is
 * generous (40 assistant turns) and the first user message is always
 * preserved verbatim. Compaction only kicks in on very long sessions
 * where context blow-up would otherwise outweigh caching gains.
 */

import type { ChatMessage } from '../providers/types'

export const DEFAULT_HISTORY_WINDOW_TURNS = 40
export const HISTORY_SUMMARY_LABEL = '<session-earlier-summary>'

type Summarise = (msgs: ChatMessage[]) => Promise<string>

/** Count assistant messages — that's how we measure "turns" here. One
 *  assistant message plus its follow-up tool results counts as one turn. */
export function countTurns(history: ChatMessage[]): number {
  let n = 0
  for (const m of history) if (m.role === 'assistant') n += 1
  return n
}

/** Find the slice of history to compact. Keeps the first user message
 *  (index 0 if user role) and the last `keep` turns; returns the range
 *  [from, to) of messages to summarise. If nothing needs compacting
 *  returns null. */
export function planCompaction(
  history: ChatMessage[],
  windowTurns: number,
): { from: number; to: number; keptTurns: number } | null {
  if (!Number.isFinite(windowTurns) || windowTurns <= 0) return null
  const totalTurns = countTurns(history)
  if (totalTurns <= windowTurns) return null

  const drop = totalTurns - windowTurns
  const startIdx = history[0]?.role === 'user' ? 1 : 0
  let seen = 0
  let cut = startIdx
  for (let i = startIdx; i < history.length; i++) {
    const m = history[i]!
    if (m.role === 'assistant') {
      seen += 1
      if (seen >= drop) {
        // Include this assistant message + any immediately-following tool
        // role rows in the summary slice so tool_call/tool_result pairs
        // stay together.
        cut = i + 1
        while (cut < history.length && history[cut]!.role === 'tool') cut += 1
        break
      }
    }
  }
  if (cut <= startIdx) return null
  return { from: startIdx, to: cut, keptTurns: windowTurns }
}

/** Replace the chosen slice with a single assistant-role summary message.
 *  If the summariser throws or returns blank, the original history is
 *  returned unchanged (quality beats compactness). */
export async function compactHistory(
  history: ChatMessage[],
  windowTurns: number,
  summarise: Summarise,
): Promise<ChatMessage[]> {
  const plan = planCompaction(history, windowTurns)
  if (!plan) return history
  const slice = history.slice(plan.from, plan.to)
  let summary: string
  try {
    summary = (await summarise(slice)).trim()
  } catch {
    return history
  }
  if (!summary) return history
  const out: ChatMessage[] = []
  out.push(...history.slice(0, plan.from))
  out.push({
    role: 'assistant',
    content:
      `${HISTORY_SUMMARY_LABEL}\n${summary}\n` +
      `[summary of ${slice.length} earlier messages, ${plan.keptTurns}-turn window active]`,
  })
  out.push(...history.slice(plan.to))
  return out
}
