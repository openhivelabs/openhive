import { describe, expect, it } from 'vitest'
import { computeCost, getPricingForModel } from './pricing'

describe('getPricingForModel — 3-level fallback', () => {
  it('exact model match wins (gpt-5-mini post-Apr-2026 rates)', () => {
    const r = getPricingForModel('openai', 'gpt-5-mini')!
    expect(r.input).toBe(0.25)
    expect(r.output).toBe(2.0)
    expect(r.cached).toBe(0.025)
  })

  it("gpt-5-mini does NOT get gpt-5's full-size rate (regression for the legacy startsWith bug)", () => {
    // The old RATES table iterated in insertion order and picked "gpt-5"
    // first because "gpt-5-mini".startsWith("gpt-5") is true. That priced
    // mini at full-size rates — 8× overbilling which caused the $0.9216 /
    // session 67 report. Post-refactor: exact match in MODEL_PRICING wins.
    const mini = getPricingForModel('openai', 'gpt-5-mini')!
    const full = getPricingForModel('openai', 'gpt-5')!
    expect(mini.input).toBeLessThan(full.input)
    expect(mini.output).toBeLessThan(full.output)
    expect(mini.input).toBe(0.25)
  })

  it('vendor-prefix strip resolves nested IDs', () => {
    const r = getPricingForModel('openrouter', 'anthropic/claude-haiku-4-5')!
    expect(r.input).toBe(1.0)
    expect(r.cached).toBe(0.1)
  })

  it('Claude reasoning equals output (extended thinking billed as output)', () => {
    const r = getPricingForModel('anthropic', 'claude-opus-4-7')!
    expect(r.reasoning).toBe(r.output)
    expect(r.reasoning).toBe(25.0)
  })

  it('GPT-5 family reasoning equals output (reasoning_tokens fold into output on wire)', () => {
    const r = getPricingForModel('openai', 'gpt-5.4')!
    expect(r.reasoning).toBe(r.output)
    expect(r.reasoning).toBe(15.0)
  })

  it('pattern fallback — claude-sonnet-9-future falls to claude-sonnet-*', () => {
    const r = getPricingForModel('anthropic', 'claude-sonnet-9-future')!
    expect(r.input).toBe(3.0)
    expect(r.output).toBe(15.0)
  })

  it('pattern fallback — gpt-5.4-preview falls to gpt-5.4-*', () => {
    const r = getPricingForModel('openai', 'gpt-5.4-preview')!
    expect(r.input).toBe(2.5)
    expect(r.output).toBe(15.0)
  })

  it('pattern fallback — gemini-future-pro falls to gemini-*-pro', () => {
    const r = getPricingForModel('google', 'gemini-future-pro')!
    expect(r.input).toBe(2.0)
  })

  it('removed families return null (qwen / kimi / deepseek / glm / o-series — not served)', () => {
    expect(getPricingForModel('openai', 'o1-preview')).toBeNull()
    expect(getPricingForModel('deepseek', 'deepseek-v3.2')).toBeNull()
    expect(getPricingForModel('qwen', 'qwen3-coder-plus')).toBeNull()
    expect(getPricingForModel('openai', 'gpt-4o')).toBeNull()
    expect(getPricingForModel('openai', 'gpt-3.5-turbo')).toBeNull()
  })

  it('unknown model returns null (caller should log + treat as 0)', () => {
    expect(getPricingForModel('x', 'totally-made-up-model-9000')).toBeNull()
  })
})

describe('computeCost', () => {
  it('gpt-5-mini (2026 rate) · 149k total input (103k cache-read) · 12k output', () => {
    const freshInput = 149_000 - 103_000 // normalized at provider layer
    const breakdown = computeCost({
      provider: 'copilot',
      model: 'gpt-5-mini',
      freshInputTokens: freshInput,
      outputTokens: 12_000,
      cacheReadTokens: 103_000,
    })
    // Hand check at Apr 2026 rates (input $0.25, cached $0.025, output $2.00):
    //   46,000 × $0.25/M     = $0.0115   ( 1.15¢)
    //  103,000 × $0.025/M    = $0.00258  ( 0.26¢)
    //   12,000 × $2.00/M     = $0.024    ( 2.40¢)
    //                          ──────────
    //                           ≈ $0.038 ( ~3.8¢)
    expect(breakdown.total_cents).toBeGreaterThan(2)
    expect(breakdown.total_cents).toBeLessThan(6)
    // Nowhere near the legacy 92.5¢ / pre-price-cut ~11¢.
    expect(breakdown.total_cents).toBeLessThan(90)
  })

  it('separates each cost bucket so the UI can surface the breakdown', () => {
    const b = computeCost({
      provider: 'copilot',
      model: 'gpt-5-mini',
      freshInputTokens: 46_000,
      outputTokens: 12_000,
      cacheReadTokens: 103_000,
      cacheWriteTokens: 0,
    })
    expect(b.fresh_input_cost_cents).toBeCloseTo(1.15, 1)
    expect(b.cache_read_cost_cents).toBeCloseTo(0.258, 2)
    expect(b.output_cost_cents).toBeCloseTo(2.4, 1)
    expect(b.cache_write_cost_cents).toBe(0)
    expect(b.reasoning_cost_cents).toBe(0)
  })

  it('returns zeros when the model is unknown instead of throwing', () => {
    const b = computeCost({
      provider: 'x',
      model: 'made-up',
      freshInputTokens: 100_000,
      outputTokens: 10_000,
    })
    expect(b.total_cents).toBe(0)
  })

  it('negative token counts clamp to zero (defensive, providers have sent -1 in the wild)', () => {
    const b = computeCost({
      provider: 'openai',
      model: 'gpt-5',
      freshInputTokens: -5,
      outputTokens: 100,
    })
    expect(b.fresh_input_cost_cents).toBe(0)
    expect(b.total_cents).toBeGreaterThan(0)
  })

  it('Claude Opus 4.7 · 5-min cache-write priced at 1.25× input', () => {
    const b = computeCost({
      provider: 'claude-code',
      model: 'claude-opus-4-7',
      freshInputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    })
    // 1M × $6.25/M = $6.25 = 625¢.
    expect(b.cache_write_cost_cents).toBeCloseTo(625, 0)
  })
})
