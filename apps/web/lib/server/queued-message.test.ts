import { describe, expect, it } from 'vitest'
import { buildTranscript, type StoredEventRow } from './sessions'

function row(
  seq: number,
  kind: string,
  data: Record<string, unknown>,
  overrides: Partial<StoredEventRow> = {},
): StoredEventRow {
  return {
    seq,
    ts: 1000 + seq,
    kind,
    depth: 0,
    node_id: null,
    tool_call_id: null,
    tool_name: null,
    data,
    ...overrides,
  }
}

describe('buildTranscript — user_message_queued dedup', () => {
  const goal = '안녕'
  const startedAt = 1_700_000_000_000

  it('renders queued bubble when no confirmed user_message exists yet', () => {
    // Engine is mid-turn, user posted a follow-up that landed in inbox.
    // The pending bubble must survive a page reload — it's the queued
    // event in events.jsonl that drives this (no FE state).
    const events: StoredEventRow[] = [
      row(0, 'user_message_queued', { text: '추가 질문이요', queued_id: 'q-abc' }),
    ]
    const lines = buildTranscript(goal, startedAt, events)
    const queued = lines.find((l) => l.kind === 'user_message_queued')
    expect(queued).toBeDefined()
    expect(queued!.text).toBe('추가 질문이요')
    expect(queued!.queued_id).toBe('q-abc')
  })

  it('drops queued bubble once matching user_message lands', () => {
    // Engine popped the message. Now there's a confirmed user_message with
    // the same queued_id — the queued line must NOT render or the chat
    // shows the same message twice.
    const events: StoredEventRow[] = [
      row(0, 'user_message_queued', { text: '추가 질문이요', queued_id: 'q-abc' }),
      row(1, 'user_message', { text: '추가 질문이요', queued_id: 'q-abc' }),
    ]
    const lines = buildTranscript(goal, startedAt, events)
    const queuedCount = lines.filter((l) => l.kind === 'user_message_queued').length
    const confirmed = lines.find((l) => l.kind === 'user_message')
    expect(queuedCount).toBe(0)
    expect(confirmed).toBeDefined()
    expect(confirmed!.text).toBe('추가 질문이요')
    expect(confirmed!.queued_id).toBe('q-abc')
  })

  it('keeps queued bubbles for OTHER queued messages even after one is confirmed', () => {
    // Two queued messages, only the first has been popped. The second
    // must still render as pending — dedup is per-queued_id, not global.
    const events: StoredEventRow[] = [
      row(0, 'user_message_queued', { text: '첫 번째', queued_id: 'q-1' }),
      row(1, 'user_message_queued', { text: '두 번째', queued_id: 'q-2' }),
      row(2, 'user_message', { text: '첫 번째', queued_id: 'q-1' }),
    ]
    const lines = buildTranscript(goal, startedAt, events)
    const queued = lines.filter((l) => l.kind === 'user_message_queued')
    const confirmed = lines.filter((l) => l.kind === 'user_message')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.queued_id).toBe('q-2')
    expect(queued[0]!.text).toBe('두 번째')
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]!.queued_id).toBe('q-1')
  })

  it('renders queued bubble when queued_id is missing on the confirmed event (legacy)', () => {
    // Defence-in-depth: an older user_message event without queued_id (e.g.
    // from a pre-migration session or the resume-as-goal path) should NOT
    // dedupe random queued bubbles by text alone — that would silently
    // swallow a fresh follow-up if its text matched a prior turn.
    const events: StoredEventRow[] = [
      row(0, 'user_message', { text: '같은 말' }), // legacy, no queued_id
      row(1, 'user_message_queued', { text: '같은 말', queued_id: 'q-fresh' }),
    ]
    const lines = buildTranscript(goal, startedAt, events)
    const queued = lines.filter((l) => l.kind === 'user_message_queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.queued_id).toBe('q-fresh')
  })
})
