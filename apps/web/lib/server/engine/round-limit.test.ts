import { describe, expect, it } from 'vitest'
import {
  makeRoundLimitEvents,
  roundLimitFallback,
} from './session'

describe('roundLimitFallback', () => {
  it('mentions the limit number in Korean', () => {
    const msg = roundLimitFallback(8, 'ko')
    expect(msg).toContain('8')
    expect(msg).toMatch(/한도|한도에/)
    // Should not be empty — the whole point of Bug #3 is that empty
    // output was silently swallowed by the UI.
    expect(msg.length).toBeGreaterThan(20)
  })

  it('mentions the limit number in English', () => {
    const msg = roundLimitFallback(8, 'en')
    expect(msg).toContain('8')
    expect(msg.toLowerCase()).toContain('round')
    expect(msg.length).toBeGreaterThan(20)
  })
})

describe('makeRoundLimitEvents', () => {
  const baseOpts = {
    sessionId: 'sess-test',
    nodeId: 'a-lead',
    role: 'Lead',
    depth: 0,
    maxRounds: 8,
    locale: 'ko' as const,
  }

  it('emits telemetry event + node_finished in that order', () => {
    const events = makeRoundLimitEvents(baseOpts)
    expect(events).toHaveLength(2)
    expect(events[0]!.kind).toBe('turn.round_limit')
    expect(events[1]!.kind).toBe('node_finished')
  })

  it('telemetry event carries the bucket data', () => {
    const [tele] = makeRoundLimitEvents(baseOpts)
    expect(tele!.data.max_rounds).toBe(8)
    expect(tele!.data.depth).toBe(0)
    expect(tele!.data.agent_role).toBe('Lead')
    expect(tele!.node_id).toBe('a-lead')
  })

  it('node_finished carries a non-empty localized output (Bug #3 regression)', () => {
    const [, done] = makeRoundLimitEvents(baseOpts)
    const out = (done!.data as { output: string }).output
    // The original bug: turn_finished.output was "" so the UI showed nothing.
    // This guard ensures we never regress to that.
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('8') // the limit number
  })

  it('swaps locale to English', () => {
    const [, done] = makeRoundLimitEvents({ ...baseOpts, locale: 'en' })
    const out = (done!.data as { output: string }).output
    expect(out.toLowerCase()).toContain('round')
  })

  it('preserves depth for sub-agent nodes', () => {
    const [tele, done] = makeRoundLimitEvents({
      ...baseOpts,
      depth: 2,
      nodeId: 'a-member',
      role: 'Member',
    })
    expect(tele!.depth).toBe(2)
    expect(done!.depth).toBe(2)
    expect(tele!.data.agent_role).toBe('Member')
  })
})
