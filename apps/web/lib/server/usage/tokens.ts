/**
 * Pure-JS token estimator.
 *
 * Not a real BPE tokenizer; intentionally conservative (×4/3 pad) so we err
 * on triggering compaction early rather than late. Authoritative values come
 * from provider `usage.input_tokens` deltas — this module is for (a) turn
 * entry before any API report exists, (b) counting messages added after the
 * last report, (c) drift calibration against real usage.
 */

import type { ChatMessage, ToolSpec } from '../providers/types'
import { effectiveWindow } from './contextWindow'

const CHARS_PER_TOKEN = 4
const PAD_FACTOR_DEFAULT = 4 / 3 // ≈ 1.333
const IMAGE_TOKENS_FLAT = 2_000
const ROLE_OVERHEAD = 4 // role + struct meta per message

function padFactor(): number {
  const raw = process.env.OPENHIVE_TOKEN_PAD_FACTOR
  if (!raw) return PAD_FACTOR_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : PAD_FACTOR_DEFAULT
}

export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0
  return Math.ceil((text.length / CHARS_PER_TOKEN) * padFactor())
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let total = ROLE_OVERHEAD
  const content = msg.content
  if (typeof content === 'string' && content) {
    total += estimateTextTokens(content)
  } else if (Array.isArray(content)) {
    for (const block of content as unknown[]) {
      const b = (block ?? {}) as Record<string, unknown>
      const type = b.type
      if (type === 'image' || type === 'image_url') {
        total += IMAGE_TOKENS_FLAT
      } else if (type === 'text' && typeof b.text === 'string') {
        total += estimateTextTokens(b.text)
      } else if (type === 'tool_use') {
        const input = b.input ?? {}
        total += estimateTextTokens(JSON.stringify(input))
      } else if (type === 'tool_result') {
        const c = b.content
        total += estimateTextTokens(typeof c === 'string' ? c : JSON.stringify(c ?? ''))
      } else {
        // Unknown block — conservative: full JSON length.
        total += estimateTextTokens(JSON.stringify(b))
      }
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const fn = tc.function ?? { name: '', arguments: '' }
      total += estimateTextTokens(fn.name ?? '')
      total += estimateTextTokens(fn.arguments ?? '')
      total += 8 // call_id + struct overhead
    }
  }
  return total
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  let sum = 0
  for (const m of msgs) sum += estimateMessageTokens(m)
  return sum
}

export function estimateToolsTokens(tools: ToolSpec[] | undefined | null): number {
  if (!tools || tools.length === 0) return 0
  return estimateTextTokens(JSON.stringify(tools)) + tools.length * 4
}

interface CountWithApiOpts {
  /** Authoritative value — direct from provider's last `usage.input_tokens`. */
  apiReportedInputTokens?: number | null
  /**
   * Index (inclusive) of the last message covered by the authoritative value.
   * Messages after this index are added via estimate. null → estimate all.
   */
  apiReportedAtIndex?: number | null
  /** System prompt tokens. Set to 0 if already included in the API value. */
  systemTokens?: number
  /** Tools schema tokens. Set to 0 if already included in the API value. */
  toolsTokens?: number
}

export function tokenCountWithEstimation(
  messages: ChatMessage[],
  opts: CountWithApiOpts = {},
): number {
  const sys = opts.systemTokens ?? 0
  const tools = opts.toolsTokens ?? 0
  const api = opts.apiReportedInputTokens ?? null
  const idx = opts.apiReportedAtIndex ?? null

  if (api !== null && idx !== null && idx >= 0) {
    let added = 0
    for (let i = idx + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (msg) added += estimateMessageTokens(msg)
    }
    return api + added
  }
  return sys + tools + estimateMessagesTokens(messages)
}

// ─── Public trigger helpers (shared by S2 microcompact, future auto-compact, UI) ───

export function shouldMicrocompact(
  estimatedTokens: number,
  providerId: string,
  model: string,
): boolean {
  return estimatedTokens > effectiveWindow(providerId, model).warningThreshold
}

export function shouldAutoCompact(
  estimatedTokens: number,
  providerId: string,
  model: string,
): boolean {
  return estimatedTokens > effectiveWindow(providerId, model).autoCompactThreshold
}

export function shouldBlockTurn(
  estimatedTokens: number,
  providerId: string,
  model: string,
): boolean {
  return estimatedTokens > effectiveWindow(providerId, model).blockingLimit
}
