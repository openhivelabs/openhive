/**
 * Per-(provider, model) context window + max-output table.
 *
 * Single source of truth for engine sizing decisions (microcompact trigger,
 * auto-compact trigger, UI warnings, turn blocking). Numbers reflect publicly
 * documented ceilings as of 2026-04; verify on model rev.
 *
 * Separate from `providers/models.ts` (UI catalogue) on purpose — that one is
 * for display, this one is for runtime math.
 */

export interface ModelWindow {
  /** Input token ceiling (system + tools + history + user turn). */
  input: number
  /** Max output tokens the model can produce. Reserved from window. */
  output: number
}

export const CONTEXT_WINDOW: Record<string, Record<string, ModelWindow>> = {
  // Anthropic — Claude Code OAuth path. [1m] beta variants are separate ids.
  'claude-code': {
    'claude-opus-4-7': { input: 200_000, output: 32_000 },
    'claude-opus-4-7[1m]': { input: 1_000_000, output: 32_000 },
    'claude-sonnet-4-6': { input: 200_000, output: 64_000 },
    'claude-sonnet-4-6[1m]': { input: 1_000_000, output: 64_000 },
    'claude-haiku-4-5': { input: 200_000, output: 16_000 },
  },
  // OpenAI Codex — ChatGPT backend Responses API. GPT-5 family public ceilings.
  // TODO(a4): re-verify on model rev; add o3 variants if codex catalogue gains them.
  codex: {
    'gpt-5': { input: 400_000, output: 128_000 },
    'gpt-5-mini': { input: 400_000, output: 128_000 },
    'gpt-5.4': { input: 400_000, output: 128_000 },
    'gpt-5.4-mini': { input: 400_000, output: 128_000 },
  },
  // GitHub Copilot — exposes the same model ids but /models response omits
  // window info, so we take conservative OpenAI defaults.
  // TODO(a4): revisit if Copilot starts reporting window.
  copilot: {
    'gpt-5': { input: 200_000, output: 32_000 },
    'gpt-5-mini': { input: 200_000, output: 32_000 },
    'gpt-5.4': { input: 200_000, output: 32_000 },
    'gpt-5.4-mini': { input: 200_000, output: 32_000 },
    'gpt-4o': { input: 128_000, output: 16_000 },
    'gpt-4o-mini': { input: 128_000, output: 16_000 },
    o3: { input: 200_000, output: 100_000 },
    'o3-mini': { input: 200_000, output: 100_000 },
  },
}

const SAFE_DEFAULT: ModelWindow = { input: 128_000, output: 8_000 }

export function contextWindow(providerId: string, model: string): ModelWindow {
  const entry = CONTEXT_WINDOW[providerId]?.[model]
  if (entry) return entry
  // Unknown model → safe default. Never crash.
  return SAFE_DEFAULT
}

const AUTOCOMPACT_BUFFER_DEFAULT = 13_000
const BLOCKING_BUFFER_DEFAULT = 3_000
const WARNING_BUFFER_DEFAULT = 20_000
const MAX_OUTPUT_RESERVE = 20_000

export interface EffectiveWindow {
  /** input - reserveOutput. Upper bound of actual prompt payload. */
  window: number
  /** Above this → kick microcompact / auto-compact. */
  autoCompactThreshold: number
  /** Above this → surface UI warning (not blocking). */
  warningThreshold: number
  /** Above this → refuse to start the turn. */
  blockingLimit: number
  meta: {
    providerId: string
    model: string
    rawInput: number
    rawOutput: number
    reserveOutput: number
    autoCompactBuffer: number
    blockingBuffer: number
  }
}

export function effectiveWindow(providerId: string, model: string): EffectiveWindow {
  const cw = contextWindow(providerId, model)
  const autoBuf = numEnv('OPENHIVE_AUTOCOMPACT_BUFFER', AUTOCOMPACT_BUFFER_DEFAULT)
  const blockBuf = numEnv('OPENHIVE_BLOCKING_BUFFER', BLOCKING_BUFFER_DEFAULT)
  const warnBuf = numEnv('OPENHIVE_WARNING_BUFFER', WARNING_BUFFER_DEFAULT)
  const reserveOutput = Math.min(cw.output, MAX_OUTPUT_RESERVE)
  const window = cw.input - reserveOutput
  return {
    window,
    autoCompactThreshold: window - autoBuf,
    warningThreshold: window - warnBuf,
    blockingLimit: window - blockBuf,
    meta: {
      providerId,
      model,
      rawInput: cw.input,
      rawOutput: cw.output,
      reserveOutput,
      autoCompactBuffer: autoBuf,
      blockingBuffer: blockBuf,
    },
  }
}

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Verification examples (kept in sync with contextWindow.test.ts):
//
// effectiveWindow('claude-code', 'claude-opus-4-7[1m]')
//   rawInput 1_000_000, rawOutput 32_000, reserveOutput 20_000
//   window               = 980_000
//   autoCompactThreshold = 967_000
//   warningThreshold     = 960_000
//   blockingLimit        = 977_000
//
// effectiveWindow('claude-code', 'claude-haiku-4-5')
//   rawOutput 16_000 (<20K cap) → reserveOutput 16_000
//   window = 184_000
