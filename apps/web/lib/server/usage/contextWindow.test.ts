import { describe, expect, it } from 'vitest'
import { contextWindow, effectiveWindow } from './contextWindow'

describe('contextWindow', () => {
  it('returns table entry for known (provider, model)', () => {
    const cw = contextWindow('claude-code', 'claude-opus-4-7')
    expect(cw).toEqual({ input: 200_000, output: 32_000 })
  })

  it('mirrors claude-code entries under anthropic provider', () => {
    expect(contextWindow('anthropic', 'claude-opus-4-7')).toEqual({ input: 200_000, output: 32_000 })
    expect(contextWindow('anthropic', 'claude-haiku-4-5')).toEqual({ input: 200_000, output: 16_000 })
  })

  it('falls back to SAFE_DEFAULT for retired [1m] beta variants (2026-04-30)', () => {
    const cw = contextWindow('claude-code', 'claude-opus-4-7[1m]')
    expect(cw).toEqual({ input: 128_000, output: 8_000 })
  })

  it('falls back to SAFE_DEFAULT for unknown model', () => {
    const cw = contextWindow('copilot', 'totally-unknown-model')
    expect(cw).toEqual({ input: 128_000, output: 8_000 })
  })

  it('falls back to SAFE_DEFAULT for unknown provider', () => {
    const cw = contextWindow('no-such-provider', 'whatever')
    expect(cw).toEqual({ input: 128_000, output: 8_000 })
  })
})

describe('effectiveWindow', () => {
  // The legacy [1m] beta is retired (2026-04-30). Test we no longer carry the
  // 1M-window thresholds and instead fall through to SAFE_DEFAULT.
  it('claude-opus-4-7[1m] (retired) → SAFE_DEFAULT 128K window', () => {
    const ew = effectiveWindow('claude-code', 'claude-opus-4-7[1m]')
    expect(ew.meta.rawInput).toBe(128_000)
    expect(ew.meta.reserveOutput).toBe(8_000)
  })

  it('claude-opus-4-7 → 180_000 window (200K - 20K reserve)', () => {
    const ew = effectiveWindow('claude-code', 'claude-opus-4-7')
    expect(ew.window).toBe(180_000)
    expect(ew.autoCompactThreshold).toBe(167_000)
    expect(ew.meta.reserveOutput).toBe(20_000)
  })

  it('claude-haiku-4-5 → output(16K) < 20K reserve cap → window 184_000', () => {
    const ew = effectiveWindow('claude-code', 'claude-haiku-4-5')
    expect(ew.meta.reserveOutput).toBe(16_000)
    expect(ew.window).toBe(184_000)
    expect(ew.autoCompactThreshold).toBe(171_000)
  })

  it('unknown model uses SAFE_DEFAULT → window 120_000 (128K - 8K reserve)', () => {
    const ew = effectiveWindow('copilot', 'unknown-model')
    expect(ew.meta.rawInput).toBe(128_000)
    expect(ew.meta.reserveOutput).toBe(8_000)
    expect(ew.window).toBe(120_000)
  })
})
