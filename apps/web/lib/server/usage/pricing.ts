/**
 * Per-model pricing table + resolver.
 *
 * Structure ported from the 9router project
 * (https://github.com/decolua/9router/blob/master/src/shared/constants/pricing.js)
 * — the most comprehensive open-source LLM pricing database we found, already
 * covering 50+ models across Claude / GPT / Gemini / Qwen / Kimi / DeepSeek /
 * GLM / Grok with separate rates for fresh input, cache read, cache creation,
 * output, and reasoning tokens.
 *
 * Before this existed OpenHive used a 9-entry `[input, output]` table with a
 * `startsWith` matcher that silently aliased "gpt-5-mini" to "gpt-5" (8× over-
 * billing) and ignored cache_read tokens entirely. That produced a $0.92
 * cost display for a session that actually cost ~$0.06.
 *
 * All rates are in $ per 1M tokens.
 */

export interface ModelRates {
  /** Fresh (uncached) input tokens. */
  input: number
  /** Output / completion tokens. */
  output: number
  /** Cache-read (prefix hit) tokens. Typically 10% of `input` for Anthropic,
   *  50% for OpenAI. */
  cached: number
  /** Optional: reasoning tokens billed separately (o-series, Claude extended
   *  thinking). Falls back to `output` when a provider reports reasoning
   *  tokens but the model has no separate rate. */
  reasoning: number
  /** Cache creation tokens (Anthropic's cache_creation_input_tokens). Usually
   *  ~1.25× input. */
  cache_creation: number
}

/** Canonical model pricing — provider-agnostic exact-match table. */
export const MODEL_PRICING: Record<string, ModelRates> = {
  // === Anthropic / Claude ===
  'claude-opus-4-7': { input: 5.0, output: 25.0, cached: 0.5, reasoning: 37.5, cache_creation: 6.25 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 },
  'claude-opus-4-5': { input: 5.0, output: 25.0, cached: 0.5, reasoning: 37.5, cache_creation: 5.0 },
  'claude-opus-4-1': { input: 5.0, output: 25.0, cached: 0.5, reasoning: 37.5, cache_creation: 5.0 },
  'claude-opus-4': { input: 15.0, output: 25.0, cached: 7.5, reasoning: 112.5, cache_creation: 15.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cached: 0.3, reasoning: 22.5, cache_creation: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cached: 0.3, reasoning: 22.5, cache_creation: 3.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cached: 1.5, reasoning: 15.0, cache_creation: 3.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cached: 0.1, reasoning: 5.0, cache_creation: 1.25 },
  'claude-haiku-4': { input: 0.8, output: 4.0, cached: 0.08, reasoning: 4.0, cache_creation: 1.0 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, cached: 1.5, reasoning: 15.0, cache_creation: 3.0 },

  // === OpenAI / GPT ===
  'gpt-5.3-codex': { input: 6.0, output: 24.0, cached: 3.0, reasoning: 36.0, cache_creation: 6.0 },
  'gpt-5.3': { input: 6.0, output: 24.0, cached: 3.0, reasoning: 36.0, cache_creation: 6.0 },
  'gpt-5.2': { input: 5.0, output: 20.0, cached: 2.5, reasoning: 30.0, cache_creation: 5.0 },
  'gpt-5.1-codex': { input: 4.0, output: 16.0, cached: 2.0, reasoning: 24.0, cache_creation: 4.0 },
  'gpt-5.1': { input: 4.0, output: 16.0, cached: 2.0, reasoning: 24.0, cache_creation: 4.0 },
  'gpt-5-codex': { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 },
  'gpt-5-mini': { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 },
  'gpt-5-nano': { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.9, cache_creation: 0.15 },
  'gpt-5': { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cached: 0.1, reasoning: 2.4, cache_creation: 0.4 },
  'gpt-4.1': { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.9, cache_creation: 0.15 },
  'gpt-4o': { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 },
  'gpt-4-turbo': { input: 10.0, output: 30.0, cached: 5.0, reasoning: 45.0, cache_creation: 10.0 },
  'gpt-4': { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5, cached: 0.25, reasoning: 2.25, cache_creation: 0.5 },

  // === OpenAI o-series (reasoning) ===
  o1: { input: 15.0, output: 60.0, cached: 7.5, reasoning: 90.0, cache_creation: 15.0 },
  'o1-mini': { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 },
  o3: { input: 10.0, output: 40.0, cached: 5.0, reasoning: 60.0, cache_creation: 10.0 },
  'o3-mini': { input: 1.1, output: 4.4, cached: 0.55, reasoning: 6.6, cache_creation: 1.1 },
  o4: { input: 2.0, output: 8.0, cached: 1.0, reasoning: 12.0, cache_creation: 2.0 },

  // === Gemini ===
  'gemini-3-pro': { input: 2.0, output: 12.0, cached: 0.25, reasoning: 18.0, cache_creation: 2.0 },
  'gemini-3-flash': { input: 0.5, output: 3.0, cached: 0.03, reasoning: 4.5, cache_creation: 0.5 },
  'gemini-2.5-pro': { input: 2.0, output: 12.0, cached: 0.25, reasoning: 18.0, cache_creation: 2.0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cached: 0.03, reasoning: 3.75, cache_creation: 0.3 },
  'gemini-2.5-flash-lite': { input: 0.15, output: 1.25, cached: 0.015, reasoning: 1.875, cache_creation: 0.15 },

  // === Qwen / Kimi / DeepSeek / GLM / Grok ===
  'qwen3-coder-plus': { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
  'qwen3-coder-flash': { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
  'kimi-k2.5-thinking': { input: 1.8, output: 7.2, cached: 0.9, reasoning: 10.8, cache_creation: 1.8 },
  'kimi-k2.5': { input: 1.2, output: 4.8, cached: 0.6, reasoning: 7.2, cache_creation: 1.2 },
  'kimi-k2-thinking': { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0, cache_creation: 1.5 },
  'kimi-k2': { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
  'deepseek-r1': { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 },
  'deepseek-v3.2': { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
  'deepseek-chat': { input: 0.28, output: 0.42, cached: 0.028, reasoning: 0.42, cache_creation: 0.28 },
  'deepseek-reasoner': { input: 0.28, output: 0.42, cached: 0.028, reasoning: 0.42, cache_creation: 0.28 },
  'glm-4.7': { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 },
  'glm-4.6': { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
  'grok-code-fast-1': { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
}

/**
 * Provider-specific overrides. Only when a provider's billing differs from the
 * canonical rate — e.g. GitHub Copilot charges different rates for gpt-5.3-codex
 * than native OpenAI API.
 *
 * Keyed by OpenHive `provider_id` (`copilot`, `claude`, `codex`, …).
 */
export const PROVIDER_PRICING: Record<string, Record<string, ModelRates>> = {
  copilot: {
    // GitHub Copilot OAuth subscription. Actual user bill is $0 (flat rate),
    // the numbers below are API-equivalent display values so the UI cost hint
    // reflects "what this would have cost on raw API". Mostly matches OpenAI
    // but gpt-5-codex variants have Copilot-specific rates in 9router.
    'gpt-5.3-codex': { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
  },
}

/**
 * Glob pattern fallback, ordered most-specific → most-general. First match wins.
 * Used when the model ID doesn't hit `PROVIDER_PRICING` or `MODEL_PRICING`.
 */
export const PATTERN_PRICING: { pattern: string; rates: ModelRates }[] = [
  // Codex variants
  { pattern: '*-codex-xhigh', rates: { input: 10.0, output: 40.0, cached: 5.0, reasoning: 60.0, cache_creation: 10.0 } },
  { pattern: '*-codex-high', rates: { input: 8.0, output: 32.0, cached: 4.0, reasoning: 48.0, cache_creation: 8.0 } },
  { pattern: '*-codex-max', rates: { input: 8.0, output: 32.0, cached: 4.0, reasoning: 48.0, cache_creation: 8.0 } },
  { pattern: '*-codex-mini-*', rates: { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0, cache_creation: 1.5 } },
  { pattern: '*-codex-mini', rates: { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0, cache_creation: 1.5 } },
  { pattern: '*-codex-low', rates: { input: 4.0, output: 16.0, cached: 2.0, reasoning: 24.0, cache_creation: 4.0 } },
  { pattern: '*-codex', rates: { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 } },
  { pattern: 'codex-*', rates: { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 } },

  // Claude family fallbacks
  { pattern: 'claude-opus-*', rates: { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 } },
  { pattern: 'claude-sonnet-*', rates: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 } },
  { pattern: 'claude-haiku-*', rates: { input: 1.0, output: 5.0, cached: 0.1, reasoning: 5.0, cache_creation: 1.25 } },
  { pattern: 'claude-*', rates: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 } },

  // Gemini tiered (specific first)
  { pattern: 'gemini-*-flash-lite', rates: { input: 0.15, output: 1.25, cached: 0.015, reasoning: 1.875, cache_creation: 0.15 } },
  { pattern: 'gemini-*-flash', rates: { input: 0.3, output: 2.5, cached: 0.03, reasoning: 3.75, cache_creation: 0.3 } },
  { pattern: 'gemini-*-pro', rates: { input: 2.0, output: 12.0, cached: 0.25, reasoning: 18.0, cache_creation: 2.0 } },
  { pattern: 'gemini-3-*', rates: { input: 0.5, output: 3.0, cached: 0.03, reasoning: 4.5, cache_creation: 0.5 } },
  { pattern: 'gemini-2.5-*', rates: { input: 0.3, output: 2.5, cached: 0.03, reasoning: 3.75, cache_creation: 0.3 } },
  { pattern: 'gemini-*', rates: { input: 0.5, output: 3.0, cached: 0.03, reasoning: 4.5, cache_creation: 0.5 } },

  // GPT family fallbacks (specific tier before generic)
  { pattern: 'gpt-5.3-*', rates: { input: 6.0, output: 24.0, cached: 3.0, reasoning: 36.0, cache_creation: 6.0 } },
  { pattern: 'gpt-5.2-*', rates: { input: 5.0, output: 20.0, cached: 2.5, reasoning: 30.0, cache_creation: 5.0 } },
  { pattern: 'gpt-5.1-*', rates: { input: 4.0, output: 16.0, cached: 2.0, reasoning: 24.0, cache_creation: 4.0 } },
  // gpt-5-mini / gpt-5-nano are exact entries above; generic gpt-5-* catches others.
  { pattern: 'gpt-5-*', rates: { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 } },
  { pattern: 'gpt-4o-mini*', rates: { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.9, cache_creation: 0.15 } },
  { pattern: 'gpt-4o*', rates: { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 } },
  { pattern: 'gpt-4*', rates: { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 } },

  // o-series
  { pattern: 'o1-*', rates: { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 } },
  { pattern: 'o3-*', rates: { input: 10.0, output: 40.0, cached: 5.0, reasoning: 60.0, cache_creation: 10.0 } },
  { pattern: 'o4-*', rates: { input: 2.0, output: 8.0, cached: 1.0, reasoning: 12.0, cache_creation: 2.0 } },

  // Misc families
  { pattern: 'qwen3-coder-*', rates: { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 } },
  { pattern: 'qwen*', rates: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 } },
  { pattern: 'kimi-*-thinking', rates: { input: 1.8, output: 7.2, cached: 0.9, reasoning: 10.8, cache_creation: 1.8 } },
  { pattern: 'kimi-k2*', rates: { input: 1.2, output: 4.8, cached: 0.6, reasoning: 7.2, cache_creation: 1.2 } },
  { pattern: 'kimi-*', rates: { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 } },
  { pattern: 'deepseek-*reasoner*', rates: { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 } },
  { pattern: 'deepseek-r*', rates: { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 } },
  { pattern: 'deepseek-v*', rates: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 } },
  { pattern: 'deepseek-*', rates: { input: 0.28, output: 0.42, cached: 0.028, reasoning: 0.42, cache_creation: 0.28 } },
  { pattern: 'glm-5*', rates: { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 } },
  { pattern: 'glm-4*', rates: { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 } },
  { pattern: 'glm-*', rates: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 } },
  { pattern: 'grok-*', rates: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 } },
]

/** Glob → RegExp. Only `*` is a wildcard; every other regex meta escapes. */
function matchPattern(pattern: string, model: string): boolean {
  const parts = pattern.split('*')
  const escaped = parts.map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp('^' + escaped.join('.*') + '$')
  return re.test(model)
}

/** Strip vendor prefix like `anthropic/claude-opus-4-7` → `claude-opus-4-7`. */
function stripVendorPrefix(model: string): string {
  return model.includes('/') ? (model.split('/').pop() ?? model) : model
}

/**
 * Resolve pricing for a (provider, model) pair. Returns null when no match —
 * callers should treat that as $0 estimate (and ideally log a warning so we
 * can extend the table).
 *
 * Resolution order:
 *   1. `PROVIDER_PRICING[provider][model]` — exact provider override
 *   2. `MODEL_PRICING[base]` where `base` is vendor-stripped
 *   3. `MODEL_PRICING[model]` (verbatim, in case someone indexed the raw ID)
 *   4. `PATTERN_PRICING` — first glob that matches
 */
export function getPricingForModel(provider: string, model: string): ModelRates | null {
  if (!model) return null
  if (provider && PROVIDER_PRICING[provider]?.[model]) {
    return PROVIDER_PRICING[provider]![model]!
  }
  const base = stripVendorPrefix(model)
  if (MODEL_PRICING[base]) return MODEL_PRICING[base]!
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]!
  for (const entry of PATTERN_PRICING) {
    if (matchPattern(entry.pattern, base) || matchPattern(entry.pattern, model)) {
      return entry.rates
    }
  }
  return null
}

export interface CostBreakdown {
  /** Fresh (non-cached) input tokens charged at `rates.input`. */
  fresh_input_cost_cents: number
  /** Cache-read tokens at `rates.cached`. */
  cache_read_cost_cents: number
  /** Cache-creation tokens at `rates.cache_creation`. */
  cache_write_cost_cents: number
  /** Output tokens at `rates.output`. */
  output_cost_cents: number
  /** Reasoning tokens at `rates.reasoning` (0 when provider didn't report). */
  reasoning_cost_cents: number
  /** Sum of the five above. */
  total_cents: number
}

export interface CostInput {
  provider: string
  model: string
  /** Fresh input tokens only (cache-read already subtracted upstream). */
  freshInputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Compute cost in cents from a fully-decomposed token bundle.
 *
 * ⚠ `freshInputTokens` MUST already exclude cache-read. Providers that report
 * a cache-inclusive total (Copilot / OpenAI `prompt_tokens`) normalize in the
 * provider adapter before arriving here. Providers that already report fresh
 * input (Anthropic) pass straight through.
 */
export function computeCost(input: CostInput): CostBreakdown {
  const rates = getPricingForModel(input.provider, input.model)
  if (!rates) {
    return {
      fresh_input_cost_cents: 0,
      cache_read_cost_cents: 0,
      cache_write_cost_cents: 0,
      output_cost_cents: 0,
      reasoning_cost_cents: 0,
      total_cents: 0,
    }
  }
  // $/1M tokens × tokens → dollars. ×100 → cents. Keep it in one expression
  // so rounding error only happens at the final sum.
  const toCents = (tokens: number, rate: number) => (tokens * rate) / 10_000

  const fresh = toCents(Math.max(0, input.freshInputTokens), rates.input)
  const cached = toCents(Math.max(0, input.cacheReadTokens ?? 0), rates.cached)
  const cacheWrite = toCents(
    Math.max(0, input.cacheWriteTokens ?? 0),
    rates.cache_creation,
  )
  const out = toCents(Math.max(0, input.outputTokens), rates.output)
  const reasoning = toCents(Math.max(0, input.reasoningTokens ?? 0), rates.reasoning)

  return {
    fresh_input_cost_cents: fresh,
    cache_read_cost_cents: cached,
    cache_write_cost_cents: cacheWrite,
    output_cost_cents: out,
    reasoning_cost_cents: reasoning,
    total_cents: fresh + cached + cacheWrite + out + reasoning,
  }
}
