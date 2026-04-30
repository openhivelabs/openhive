/**
 * Per-model pricing table + resolver.
 *
 * SCOPE — OpenHive ships three providers (claude-code / codex / copilot).
 * This table covers models those three providers actually serve as of
 * 2026-04-23:
 *
 *   - claude-code (Claude subscription, Anthropic-hosted)
 *       Opus 4.7, Sonnet 4.6, Haiku 4.5 (+ 4.x back-catalog still accepted
 *       by the API but routed to the same rate tier)
 *   - codex (OpenAI Codex subscription)
 *       GPT-5.4, GPT-5.4-mini, GPT-5, GPT-5-mini
 *   - copilot (GitHub Copilot OAuth)
 *       Dynamic list — as of Apr 2026 Copilot returns:
 *         OpenAI:    gpt-4.1, gpt-5-mini, gpt-5.2, gpt-5.2-codex,
 *                    gpt-5.3-codex, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano
 *         Anthropic: haiku-4-5, opus-4-5/4-6/4-7, sonnet-4/4-5/4-6
 *         Google:    gemini-2.5-pro, gemini-3-flash, gemini-3.1-pro
 *         xAI:       grok-code-fast-1
 *
 * Removed from prior table (provider never served by OpenHive):
 * Qwen / Kimi / DeepSeek / GLM, o-series (o1/o3/o4), pre-GPT-5 OpenAI
 * (3.5 / 4 / 4-turbo / 4o / 4o-mini), pre-Haiku-4.5 Claude.
 *
 * All rates are $ per 1M tokens.
 *
 * Authoritative sources used (verified 2026-04-23):
 *   - https://platform.claude.com/docs/en/about-claude/pricing
 *   - https://developers.openai.com/api/docs/pricing
 *   - https://ai.google.dev/gemini-api/docs/pricing
 *   - https://docs.github.com/en/copilot/reference/ai-models/supported-models
 *
 * Note on `reasoning`: Claude bills extended-thinking tokens as regular
 * output tokens (no separate rate) — so for Anthropic models `reasoning`
 * equals `output`. Same for the GPT-5 family (reasoning_tokens roll up into
 * output_tokens on the wire). Kept as an explicit field so providers that
 * DO split it out in the future (o-series revival, Gemini reasoning mode)
 * can slot in without changing the `ModelRates` shape.
 */

interface ModelRates {
  /** Fresh (uncached) input tokens. */
  input: number
  /** Output / completion tokens. */
  output: number
  /** Cache-read (prefix hit) tokens. Typically 10% of `input` on both
   *  Anthropic and OpenAI as of 2026. */
  cached: number
  /** Reasoning tokens billed separately. For providers that don't split
   *  these out on the wire, set = `output` so the calculator folds
   *  them into the output bucket cleanly. */
  reasoning: number
  /** Cache creation tokens (Anthropic's cache_creation_input_tokens,
   *  5-minute TTL write). 1.25x input on Anthropic, 1x input elsewhere
   *  (OpenAI / Google autocache without a per-write charge). */
  cache_creation: number
  /** Long-context threshold. When the response's input tokens exceed
   *  this, GPT-5.5 / 5.4 charge `long_context_input_multiplier` × input
   *  and `long_context_output_multiplier` × output for the full call.
   *  OpenAI quotes this for the >272k input bracket. */
  long_context_threshold?: number
  long_context_input_multiplier?: number
  long_context_output_multiplier?: number
}

/** Canonical model pricing — provider-agnostic exact-match table. */
const MODEL_PRICING: Record<string, ModelRates> = {
  // === Anthropic / Claude (platform.claude.com/docs/en/about-claude/pricing) ===
  // Cache write column = 5-minute TTL (1.25x input). 1-hour TTL is 2x input
  // — if that ever gets used, add it behind a flag; most traffic is 5-min.
  'claude-opus-4-7': { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 },
  'claude-opus-4-5': { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cached: 0.1, reasoning: 5.0, cache_creation: 1.25 },

  // === OpenAI / GPT (developers.openai.com/api/docs/pricing) ===
  // GPT-5.5 (2026-04-23, Codex-only via ChatGPT sign-in at launch).
  // Standard rate card $5 / $30 per 1M in/out; Pro variant $30 / $180.
  // `cached` rates default to 10% of input per OpenAI's 90% cache discount
  // (same pattern as the rest of this table); reasoning matches output.
  'gpt-5.5': {
    input: 5.0, output: 30.0, cached: 0.5, reasoning: 30.0, cache_creation: 5.0,
    // >272k input → 2x input / 1.5x output for the whole call. Verified
    // 2026-04-30 against developers.openai.com/api/docs/pricing.
    long_context_threshold: 272_000,
    long_context_input_multiplier: 2.0,
    long_context_output_multiplier: 1.5,
  },
  'gpt-5.5-pro': { input: 30.0, output: 180.0, cached: 3.0, reasoning: 180.0, cache_creation: 30.0 },

  // GPT-5.4 family — previous default tier. Same long-context bracket
  // applies (1.05M context with 2x/1.5x markup over 272k).
  'gpt-5.4': {
    input: 2.5, output: 15.0, cached: 0.25, reasoning: 15.0, cache_creation: 2.5,
    long_context_threshold: 272_000,
    long_context_input_multiplier: 2.0,
    long_context_output_multiplier: 1.5,
  },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cached: 0.075, reasoning: 4.5, cache_creation: 0.75 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cached: 0.02, reasoning: 1.25, cache_creation: 0.2 },

  // Codex variants (specialised coding fine-tunes — Copilot + Codex subs).
  'gpt-5.3-codex': { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
  'gpt-5.2-codex': { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },

  // GPT-5.2 chat (Copilot).
  'gpt-5.2': { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },

  // GPT-5 base (price-cut April 2026 — pricepertoken.com / nicolalazzari.ai).
  'gpt-5': { input: 0.625, output: 5.0, cached: 0.0625, reasoning: 5.0, cache_creation: 0.625 },
  'gpt-5-mini': { input: 0.25, output: 2.0, cached: 0.025, reasoning: 2.0, cache_creation: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005, reasoning: 0.4, cache_creation: 0.05 },

  // GPT-4.1 — still in Copilot's auto-selection list. Retained from
  // OpenAI's 2025 rate card (no 2026 update; OpenAI's new pricing page
  // no longer lists it, treat as frozen).
  'gpt-4.1': { input: 2.0, output: 8.0, cached: 0.5, reasoning: 8.0, cache_creation: 2.0 },

  // === Google / Gemini (ai.google.dev/gemini-api/docs/pricing — Apr 2026) ===
  // Copilot-only channel; OpenHive doesn't have a direct Gemini provider.
  // Rates below are the sub-200k-context tier; long-context surcharge
  // (2x input, 1.5x output) not modelled yet — flag if real traffic hits it.
  'gemini-3.1-pro': { input: 2.0, output: 12.0, cached: 0.2, reasoning: 12.0, cache_creation: 2.0 },
  'gemini-3-flash': { input: 0.5, output: 3.0, cached: 0.05, reasoning: 3.0, cache_creation: 0.5 },
  'gemini-2.5-pro': { input: 2.0, output: 12.0, cached: 0.25, reasoning: 12.0, cache_creation: 2.0 },

  // === xAI / Grok (Copilot-only) ===
  'grok-code-fast-1': { input: 0.5, output: 2.0, cached: 0.25, reasoning: 2.0, cache_creation: 0.5 },
}

/**
 * Provider-specific overrides. Only populate when a provider's billing
 * actually differs from the canonical rate — as of Apr 2026 all three
 * OpenHive providers track upstream rate cards, so this is empty. Kept
 * as a typed hook so future divergence (e.g. Copilot introducing its
 * own markup) can slot in without a refactor.
 *
 * Keyed by OpenHive `provider_id` (`claude-code`, `codex`, `copilot`).
 */
const PROVIDER_PRICING: Record<string, Record<string, ModelRates>> = {}

/**
 * Glob pattern fallback, ordered most-specific → most-general. First match
 * wins. Covers only the model families the three OpenHive providers serve;
 * unknown IDs return null from `getPricingForModel` so the caller can log.
 */
const PATTERN_PRICING: { pattern: string; rates: ModelRates }[] = [
  // Claude family fallbacks — future variants within a tier inherit the tier rate.
  { pattern: 'claude-opus-*', rates: { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 } },
  { pattern: 'claude-sonnet-*', rates: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 } },
  { pattern: 'claude-haiku-*', rates: { input: 1.0, output: 5.0, cached: 0.1, reasoning: 5.0, cache_creation: 1.25 } },
  { pattern: 'claude-*', rates: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 } },

  // GPT-5 family — specific tier before generic catch-all.
  { pattern: 'gpt-5.4-nano*', rates: { input: 0.2, output: 1.25, cached: 0.02, reasoning: 1.25, cache_creation: 0.2 } },
  { pattern: 'gpt-5.4-mini*', rates: { input: 0.75, output: 4.5, cached: 0.075, reasoning: 4.5, cache_creation: 0.75 } },
  { pattern: 'gpt-5.4-*', rates: { input: 2.5, output: 15.0, cached: 0.25, reasoning: 15.0, cache_creation: 2.5 } },
  { pattern: 'gpt-5.3-*', rates: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 } },
  { pattern: 'gpt-5.2-*', rates: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 } },
  { pattern: 'gpt-5-nano*', rates: { input: 0.05, output: 0.4, cached: 0.005, reasoning: 0.4, cache_creation: 0.05 } },
  { pattern: 'gpt-5-mini*', rates: { input: 0.25, output: 2.0, cached: 0.025, reasoning: 2.0, cache_creation: 0.25 } },
  { pattern: 'gpt-5-codex*', rates: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 } },
  { pattern: 'gpt-5-*', rates: { input: 0.625, output: 5.0, cached: 0.0625, reasoning: 5.0, cache_creation: 0.625 } },
  { pattern: '*-codex', rates: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 } },

  // Gemini tiered (specific first).
  { pattern: 'gemini-*-flash', rates: { input: 0.5, output: 3.0, cached: 0.05, reasoning: 3.0, cache_creation: 0.5 } },
  { pattern: 'gemini-*-pro', rates: { input: 2.0, output: 12.0, cached: 0.2, reasoning: 12.0, cache_creation: 2.0 } },
  { pattern: 'gemini-3-*', rates: { input: 0.5, output: 3.0, cached: 0.05, reasoning: 3.0, cache_creation: 0.5 } },
  { pattern: 'gemini-*', rates: { input: 0.5, output: 3.0, cached: 0.05, reasoning: 3.0, cache_creation: 0.5 } },

  // xAI Grok catch-all.
  { pattern: 'grok-*', rates: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 2.0, cache_creation: 0.5 } },
]

/** Glob → RegExp. Only `*` is a wildcard; every other regex meta escapes. */
function matchPattern(pattern: string, model: string): boolean {
  const parts = pattern.split('*')
  const escaped = parts.map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`^${escaped.join('.*')}$`)
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
    return PROVIDER_PRICING[provider][model]
  }
  const base = stripVendorPrefix(model)
  if (MODEL_PRICING[base]) return MODEL_PRICING[base]
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]
  for (const entry of PATTERN_PRICING) {
    if (matchPattern(entry.pattern, base) || matchPattern(entry.pattern, model)) {
      return entry.rates
    }
  }
  return null
}

interface CostBreakdown {
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

interface CostInput {
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

  // Long-context surcharge (GPT-5.5 / 5.4): when the call's TOTAL input
  // (fresh + cached) exceeds the threshold, the input + output rates are
  // multiplied for the whole call. Cache-write and reasoning are not
  // documented as marked up, so we leave them at base rate.
  const totalInput =
    Math.max(0, input.freshInputTokens) + Math.max(0, input.cacheReadTokens ?? 0)
  const longCtx =
    rates.long_context_threshold !== undefined &&
    totalInput > rates.long_context_threshold
  const inMul = longCtx ? rates.long_context_input_multiplier ?? 1 : 1
  const outMul = longCtx ? rates.long_context_output_multiplier ?? 1 : 1

  // $/1M tokens × tokens → dollars. ×100 → cents. Keep it in one expression
  // so rounding error only happens at the final sum.
  const toCents = (tokens: number, rate: number) => (tokens * rate) / 10_000

  const fresh = toCents(Math.max(0, input.freshInputTokens), rates.input * inMul)
  const cached = toCents(Math.max(0, input.cacheReadTokens ?? 0), rates.cached * inMul)
  const cacheWrite = toCents(Math.max(0, input.cacheWriteTokens ?? 0), rates.cache_creation)
  const out = toCents(Math.max(0, input.outputTokens), rates.output * outMul)
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
