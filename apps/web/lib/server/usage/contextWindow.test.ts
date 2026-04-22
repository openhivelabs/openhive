import { afterEach, describe, expect, it } from 'vitest'
import { contextWindow, effectiveWindow } from './contextWindow'

const ENV_KEYS = [
  'OPENHIVE_AUTOCOMPACT_BUFFER',
  'OPENHIVE_BLOCKING_BUFFER',
  'OPENHIVE_WARNING_BUFFER',
]

function clearEnv() {
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k)
}

describe('contextWindow', () => {
  afterEach(clearEnv)

  it('returns table entry for known (provider, model)', () => {
    const cw = contextWindow('claude-code', 'claude-opus-4-7[1m]')
    expect(cw).toEqual({ input: 1_000_000, output: 32_000 })
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
  afterEach(clearEnv)

  it('claude-opus-4-7[1m] → 980_000 window, 967K autocompact, 960K warn, 977K block', () => {
    const ew = effectiveWindow('claude-code', 'claude-opus-4-7[1m]')
    expect(ew.window).toBe(980_000)
    expect(ew.autoCompactThreshold).toBe(967_000)
    expect(ew.warningThreshold).toBe(960_000)
    expect(ew.blockingLimit).toBe(977_000)
    expect(ew.meta.reserveOutput).toBe(20_000)
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

  it('env override shifts autoCompactThreshold', () => {
    process.env.OPENHIVE_AUTOCOMPACT_BUFFER = '5000'
    const ew = effectiveWindow('claude-code', 'claude-opus-4-7[1m]')
    expect(ew.window).toBe(980_000)
    expect(ew.autoCompactThreshold).toBe(975_000)
    expect(ew.meta.autoCompactBuffer).toBe(5_000)
  })

  it('invalid env falls back to default', () => {
    process.env.OPENHIVE_BLOCKING_BUFFER = 'not-a-number'
    const ew = effectiveWindow('claude-code', 'claude-opus-4-7[1m]')
    expect(ew.blockingLimit).toBe(977_000)
    expect(ew.meta.blockingBuffer).toBe(3_000)
  })
})
