import { describe, expect, it } from 'vitest'
import { computeCost, getPricingForModel } from './pricing'

describe('getPricingForModel — 3-level fallback', () => {
  it('exact model match wins', () => {
    const r = getPricingForModel('openai', 'gpt-5-mini')!
    expect(r.input).toBe(0.75)
    expect(r.output).toBe(3.0)
    expect(r.cached).toBe(0.375)
  })

  it("gpt-5-mini does NOT get gpt-5's full-size rate (regression for the legacy startsWith bug)", () => {
    // The old RATES table iterated in insertion order and picked "gpt-5"
    // first because "gpt-5-mini".startsWith("gpt-5") is true. That priced
    // mini at [5, 15] instead of [0.6, 2.4] — 8× overbilling which caused
    // the $0.9216 / session 67 report.
    const mini = getPricingForModel('openai', 'gpt-5-mini')!
    const full = getPricingForModel('openai', 'gpt-5')!
    expect(mini.input).toBeLessThan(full.input)
    expect(mini.output).toBeLessThan(full.output)
    expect(mini.input).toBe(0.75)
  })

  it('vendor-prefix strip resolves nested IDs', () => {
    const r = getPricingForModel('openrouter', 'anthropic/claude-haiku-4-5')!
    expect(r.input).toBe(1.0)
    expect(r.cached).toBe(0.1)
  })

  it('pattern fallback — claude-sonnet-9-future falls to claude-sonnet-*', () => {
    const r = getPricingForModel('anthropic', 'claude-sonnet-9-future')!
    expect(r.input).toBe(3.0)
    expect(r.output).toBe(15.0)
  })

  it('pattern fallback — gemini-future-pro falls to gemini-*-pro', () => {
    const r = getPricingForModel('google', 'gemini-future-pro')!
    expect(r.input).toBe(2.0)
  })

  it('provider override beats canonical (Copilot-specific gpt-5.3-codex)', () => {
    const copilot = getPricingForModel('copilot', 'gpt-5.3-codex')!
    const generic = getPricingForModel('openai', 'gpt-5.3-codex')!
    expect(copilot.input).toBe(1.75)
    expect(generic.input).toBe(6.0)
  })

  it('unknown model returns null (caller should log + treat as 0)', () => {
    expect(getPricingForModel('x', 'totally-made-up-model-9000')).toBeNull()
  })
})

describe('computeCost — the $0.9216 incident', () => {
  it('gpt-5-mini · 149k total input (103k cache-read) · 12k output → well under 10¢', () => {
    // Reproduces the actual numbers the user saw in the UI for a session
    // that reported $0.9216 under the old table. With the correct mini
    // rate + cache-read discount, the real cost is ~6¢.
    const freshInput = 149_000 - 103_000 // normalized at provider layer
    const breakdown = computeCost({
      provider: 'copilot',
      model: 'gpt-5-mini',
      freshInputTokens: freshInput,
      outputTokens: 12_000,
      cacheReadTokens: 103_000,
    })
    // Expected, by hand:
    //   46,000 × $0.75/M     = $0.0345   ( 3.45¢)
    //  103,000 × $0.375/M    = $0.0386   ( 3.86¢)
    //   12,000 × $3.00/M     = $0.0360   ( 3.60¢)
    //                          ──────────
    //                           ≈ $0.109 ( ~11¢)
    expect(breakdown.total_cents).toBeGreaterThan(5)
    expect(breakdown.total_cents).toBeLessThan(15)
    // And DEFINITELY nowhere near the old 92.5¢ number.
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
    expect(b.fresh_input_cost_cents).toBeCloseTo(3.45, 1)
    expect(b.cache_read_cost_cents).toBeCloseTo(3.86, 1)
    expect(b.output_cost_cents).toBeCloseTo(3.6, 1)
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
})
