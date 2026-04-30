/**
 * Async auto-title generation for sessions.
 *
 * Fires a single cheap LLM call to produce a 6-10 word human-friendly title
 * from the goal text. Fire-and-forget from driveSession once the first
 * run_started event has been persisted. Failures are swallowed and return
 * null — a missing title falls back to the goal slice in the UI.
 *
 * Provider routing: `pickCheapModel()` walks connected providers and returns
 * the cheapest available. Copilot's `chatCompletion` is the fast path because
 * it's already a one-shot string API; other providers go through the engine's
 * generic `stream()` and concatenate text deltas.
 *
 * Spec: docs/superpowers/specs/2026-04-22-session-auto-title.md
 */

import { stream as engineStream } from '../engine/providers'
import { pickCheapModel } from '../providers/cheap-model'
import { chatCompletion } from '../providers/copilot'

type TitleLocale = 'en' | 'ko'

const TIMEOUT_MS = 10_000
const MAX_WORDS = 10

function normaliseLocale(locale: string | undefined | null): TitleLocale {
  return locale === 'ko' ? 'ko' : 'en'
}

/** Collapse whitespace, strip surrounding quotes, drop a trailing period, cap
 *  to MAX_WORDS. Returns null if nothing usable survives. */
function sanitizeTitle(raw: string): string | null {
  let t = raw.trim()
  if (!t) return null
  // Strip common quote pairs the model sometimes adds despite the instruction.
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim()
  // Collapse internal whitespace / newlines.
  t = t.replace(/\s+/g, ' ')
  // Drop trailing sentence-ending punctuation that doesn't belong in a title.
  t = t.replace(/[.!?…]+$/u, '').trim()
  if (!t) return null
  const words = t.split(' ').filter(Boolean)
  if (words.length === 0) return null
  const capped = words.slice(0, MAX_WORDS).join(' ')
  return capped || null
}

/** Run `fn` with a hard timeout. Resolves to null if it exceeds `ms`. */
async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T | null> {
  return Promise.race<T | null>([
    fn(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ])
}

interface GenerateTitleDeps {
  /** Injectable for tests — defaults to dispatching through the connected
   *  cheap-model picked by `pickCheapModel`. */
  complete?: (goal: string, locale: TitleLocale) => Promise<string>
  timeoutMs?: number
}

async function defaultComplete(goal: string, locale: TitleLocale): Promise<string> {
  const localeName = locale === 'ko' ? 'Korean (한국어)' : 'English'
  const prompt =
    `Produce a 6-10 word session title in ${localeName}. ` +
    `Return only the title, no quotes, no trailing punctuation.\n\nGoal: ${goal}`
  const messages = [
    { role: 'system' as const, content: 'You write short, concrete titles.' },
    { role: 'user' as const, content: prompt },
  ]

  const choice = pickCheapModel()
  if (!choice) {
    // No connected provider — caller's catch path turns this into null which
    // becomes "title generation skipped" in the UI.
    throw new Error('no provider connected for title generation')
  }

  // Copilot has a one-shot `chatCompletion` helper that returns a string
  // directly; preserve the fast path because copilot subscriptions are free
  // for the user and avoid the streaming overhead.
  if (choice.providerId === 'copilot') {
    return chatCompletion({ model: choice.model, messages, temperature: 0.3 })
  }

  // All other providers go through the engine's generic stream(). We
  // accumulate text deltas; tool_call / native_tool / usage events are
  // dropped because a title generator never needs tools.
  let text = ''
  for await (const delta of engineStream(choice.providerId, choice.model, messages, undefined, {
    temperature: 0.3,
    nativeWebSearch: false,
  })) {
    if (delta.kind === 'text') text += delta.text
  }
  return text
}

/**
 * Generate a session title from the user's goal. Returns null on any failure
 * (empty goal, provider error, timeout, empty response). Never throws.
 */
export async function generateTitle(
  goal: string,
  locale: TitleLocale | string = 'en',
  deps: GenerateTitleDeps = {},
): Promise<string | null> {
  const trimmed = typeof goal === 'string' ? goal.trim() : ''
  if (!trimmed) return null

  const loc = normaliseLocale(locale)
  const complete = deps.complete ?? defaultComplete
  const timeout = deps.timeoutMs ?? TIMEOUT_MS

  let raw: string | null
  try {
    raw = await withTimeout(() => complete(trimmed, loc), timeout)
  } catch {
    return null
  }
  if (raw == null) return null
  return sanitizeTitle(raw)
}
