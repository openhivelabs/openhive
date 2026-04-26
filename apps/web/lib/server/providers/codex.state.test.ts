import { beforeEach, describe, expect, it } from 'vitest'

import { __test, clearCodexChain } from './codex'

const { getState, stateMap, chainStateKey } = __test

describe('codex per-chain state isolation', () => {
  beforeEach(() => {
    stateMap().clear()
  })

  it('returns the same state object for repeated lookups of one chain', () => {
    const a1 = getState('sess-A:chain-1')
    const a2 = getState('sess-A:chain-1')
    expect(a1).toBe(a2)
  })

  it('isolates two chains within the same session', () => {
    const a = getState('sess-A:chain-1')
    const b = getState('sess-A:chain-2')
    expect(a).not.toBe(b)
    a.lastReasonings.push({ type: 'reasoning', id: 'r-1' })
    expect(b.lastReasonings).toEqual([])
  })

  it('falls back to sessionId when chainKey is undefined', () => {
    const direct = getState('sess-A')
    const fromKey = getState(chainStateKey('sess-A'))
    expect(direct).toBe(fromKey)
  })

  it('treats empty/undefined keys as the same default bucket', () => {
    const a = getState(undefined)
    const b = getState('')
    expect(a).toBe(b)
  })

  it('clearCodexChain sweeps every chain belonging to a session', () => {
    getState('sess-X:chain-1').lastReasonings.push({ type: 'reasoning', id: 'r-1' })
    getState('sess-X:chain-2').lastReasonings.push({ type: 'reasoning', id: 'r-2' })
    getState('sess-X')
    getState('sess-Y:chain-1').lastReasonings.push({ type: 'reasoning', id: 'r-3' })

    clearCodexChain('sess-X')

    expect(stateMap().has('sess-X')).toBe(false)
    expect(stateMap().has('sess-X:chain-1')).toBe(false)
    expect(stateMap().has('sess-X:chain-2')).toBe(false)
    expect(stateMap().has('sess-Y:chain-1')).toBe(true)
  })
})
