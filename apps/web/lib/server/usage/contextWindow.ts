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

interface ModelWindow {
  /** Input token ceiling (system + tools + history + user turn). */
  input: number
  /** Max output tokens the model can produce. Reserved from window. */
  output: number
}

const CONTEXT_WINDOW: Record<string, Record<string, ModelWindow>> = {
  // Anthropic — Claude Code OAuth path. `context-1m-2025-08-07` beta retired
  // 2026-04-30; `[1m]` variants removed.
  'claude-code': {
    'claude-opus-4-7': { input: 200_000, output: 32_000 },
    'claude-sonnet-4-6': { input: 200_000, output: 64_000 },
    'claude-haiku-4-5': { input: 200_000, output: 16_000 },
  },
  // Anthropic — raw API key path. Same models, same wire as claude-code; the
  // distinction is the auth scheme. Sharing the same numbers keeps the engine
  // sizing predictable across both paths.
  anthropic: {
    'claude-opus-4-7': { input: 200_000, output: 32_000 },
    'claude-sonnet-4-6': { input: 200_000, output: 64_000 },
    'claude-haiku-4-5': { input: 200_000, output: 16_000 },
  },
  // OpenAI Codex — ChatGPT backend Responses API. GPT-5 family public ceilings.
  codex: {
    'gpt-5.5': { input: 1_050_000, output: 130_000 },
    'gpt-5.4': { input: 1_050_000, output: 130_000 },
    'gpt-5.4-mini': { input: 400_000, output: 130_000 },
    'gpt-5-mini': { input: 400_000, output: 128_000 },
  },
  // OpenAI direct API key — same model id space as codex, same ceilings.
  openai: {
    'gpt-5.5': { input: 1_050_000, output: 130_000 },
    'gpt-5.4': { input: 1_050_000, output: 130_000 },
    'gpt-5.4-mini': { input: 400_000, output: 130_000 },
    'gpt-5-mini': { input: 400_000, output: 128_000 },
  },
  // Gemini api_key — Google AI Studio. Gemini 3 preview models only;
  // 2.5 retired 2026-06-17 and never carried in the catalogue.
  gemini: {
    'gemini-3.1-pro-preview': { input: 1_000_000, output: 64_000 },
    'gemini-3-flash-preview': { input: 1_000_000, output: 64_000 },
    'gemini-3.1-flash-lite-preview': { input: 1_000_000, output: 64_000 },
  },
  // Vertex AI — same wire as Gemini; default region is `global` because
  // Gemini 3 preview models are not provisioned in us-central1 / us-west4
  // (verified 2026-04-30 probe).
  'vertex-ai': {
    'gemini-3.1-pro-preview': { input: 1_000_000, output: 64_000 },
    'gemini-3-flash-preview': { input: 1_000_000, output: 64_000 },
    'gemini-3.1-flash-lite-preview': { input: 1_000_000, output: 64_000 },
  },
  // GitHub Copilot — exposes mixed vendor models but /models response omits
  // window info, so we take conservative OpenAI defaults.
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

const AUTOCOMPACT_BUFFER = 13_000
const BLOCKING_BUFFER = 3_000
const WARNING_BUFFER = 20_000
const MAX_OUTPUT_RESERVE = 20_000

interface EffectiveWindow {
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
  const reserveOutput = Math.min(cw.output, MAX_OUTPUT_RESERVE)
  const window = cw.input - reserveOutput
  return {
    window,
    autoCompactThreshold: window - AUTOCOMPACT_BUFFER,
    warningThreshold: window - WARNING_BUFFER,
    blockingLimit: window - BLOCKING_BUFFER,
    meta: {
      providerId,
      model,
      rawInput: cw.input,
      rawOutput: cw.output,
      reserveOutput,
      autoCompactBuffer: AUTOCOMPACT_BUFFER,
      blockingBuffer: BLOCKING_BUFFER,
    },
  }
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
