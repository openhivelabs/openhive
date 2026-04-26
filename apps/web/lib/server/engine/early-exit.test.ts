import { describe, expect, it } from 'vitest'
import {
  earlyExitFallback,
  makeEarlyExitEvents,
  pushUserMessage,
} from './session'

describe('earlyExitFallback', () => {
  it('returns a non-empty Korean string', () => {
    const msg = earlyExitFallback('ko')
    // Resume parser drops node_finished entries with empty output, so this
    // string must always be non-empty — same Bug #3-style invariant as
    // roundLimitFallback.
    expect(msg.length).toBeGreaterThan(0)
    expect(msg).toMatch(/멈췄|멈춤|잠시|다음/)
  })

  it('returns a non-empty English string', () => {
    const msg = earlyExitFallback('en')
    expect(msg.length).toBeGreaterThan(0)
    expect(msg.toLowerCase()).toMatch(/paus|next message/)
  })
})

describe('makeEarlyExitEvents', () => {
  const baseOpts = {
    sessionId: 'sess-test',
    nodeId: 'a-lead',
    role: 'Lead',
    depth: 0,
    roundsCompleted: 3,
    previousOutput: '',
    locale: 'ko' as const,
  }

  it('emits telemetry event + node_finished in that order', () => {
    const events = makeEarlyExitEvents(baseOpts)
    expect(events).toHaveLength(2)
    expect(events[0]!.kind).toBe('turn.early_exit')
    expect(events[1]!.kind).toBe('node_finished')
  })

  it('telemetry event carries reason + counters', () => {
    const [tele] = makeEarlyExitEvents(baseOpts)
    expect(tele!.data.reason).toBe('user_queued_message')
    expect(tele!.data.rounds_completed).toBe(3)
    expect(tele!.data.depth).toBe(0)
    expect(tele!.data.agent_role).toBe('Lead')
    expect(tele!.node_id).toBe('a-lead')
  })

  it('reuses non-empty previousOutput as the synthetic node_finished output', () => {
    const partial = '잠시만요, 이 부분 확인할게요…'
    const [, done] = makeEarlyExitEvents({ ...baseOpts, previousOutput: partial })
    const out = (done!.data as { output: string }).output
    // The partial assistant text was already streamed via tokens; reusing it
    // verbatim keeps the chat bubble consistent with what the user saw.
    expect(out).toBe(partial)
  })

  it('falls back to the localized message when previousOutput is empty', () => {
    const [, done] = makeEarlyExitEvents({ ...baseOpts, previousOutput: '' })
    const out = (done!.data as { output: string }).output
    expect(out).toBe(earlyExitFallback('ko'))
    expect(out.length).toBeGreaterThan(0)
  })

  it('falls back when previousOutput is whitespace-only', () => {
    const [, done] = makeEarlyExitEvents({
      ...baseOpts,
      previousOutput: '   \n\t  ',
    })
    const out = (done!.data as { output: string }).output
    // Whitespace-only output would render as a blank Lead bubble and break
    // resume (buildLeadHistoryFromEvents filters on output.trim()).
    expect(out).toBe(earlyExitFallback('ko'))
  })

  it('swaps locale to English', () => {
    const [, done] = makeEarlyExitEvents({ ...baseOpts, locale: 'en' })
    const out = (done!.data as { output: string }).output
    expect(out.toLowerCase()).toMatch(/paus|next message/)
  })

  it('preserves depth + role on sub-agent invocations', () => {
    // The runNode peek only fires at depth=0 by design, but the helper
    // itself is depth-agnostic so depth/role plumbing is regression-tested.
    const [tele, done] = makeEarlyExitEvents({
      ...baseOpts,
      depth: 1,
      nodeId: 'a-researcher',
      role: 'Researcher',
    })
    expect(tele!.depth).toBe(1)
    expect(done!.depth).toBe(1)
    expect(tele!.data.agent_role).toBe('Researcher')
  })
})

describe('pushUserMessage / inbox interaction', () => {
  it('returns false when no live session exists for the id', () => {
    // No engine has called ensureQueue for this sessionId, so the inbox map
    // entry is missing — push must NOT silently create one (would let
    // dead-session messages accumulate forever).
    const ok = pushUserMessage('sess-does-not-exist', 'hi')
    expect(ok).toBe(false)
  })
})
