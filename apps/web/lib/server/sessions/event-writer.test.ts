import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FLUSH_INTERVAL_MS,
  FLUSH_THRESHOLD,
  __resetForTests,
  __setPathResolver,
  dropIdleQueues,
  enqueueEvent,
  flushAll,
  flushSession,
  getEventWriterMetrics,
  hasQueueForTest,
} from './event-writer'

let tmpRoot: string

function fileFor(sessionId: string): string {
  return path.join(tmpRoot, sessionId, 'events.jsonl')
}

function readLines(sessionId: string): string[] {
  const p = fileFor(sessionId)
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-event-writer-'))
  __setPathResolver((id) => fileFor(id))
})

afterEach(() => {
  __resetForTests()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('event-writer', () => {
  it('flushes a small batch on the 100ms timer', async () => {
    const sid = 's1'
    enqueueEvent(sid, JSON.stringify({ seq: 0, msg: 'a' }))
    enqueueEvent(sid, JSON.stringify({ seq: 1, msg: 'b' }))
    enqueueEvent(sid, JSON.stringify({ seq: 2, msg: 'c' }))

    // Before timer fires the file may not exist yet.
    expect(readLines(sid)).toHaveLength(0)

    await new Promise((r) => setTimeout(r, FLUSH_INTERVAL_MS + 60))
    // Let the chained flush settle.
    await flushSession(sid)

    const lines = readLines(sid)
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2])
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['a', 'b', 'c'])
  })

  it('flushes immediately when the buffer reaches the threshold', async () => {
    const sid = 's2'
    for (let i = 0; i < FLUSH_THRESHOLD; i += 1) {
      enqueueEvent(sid, JSON.stringify({ seq: i }))
    }
    // No timer wait — threshold-triggered flush should be dispatched on the
    // next microtask without hitting the 100ms timer.
    await flushSession(sid)

    const lines = readLines(sid)
    expect(lines).toHaveLength(FLUSH_THRESHOLD)
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual(
      Array.from({ length: FLUSH_THRESHOLD }, (_, i) => i),
    )
  })

  it('flushSession drains pending events before resolving', async () => {
    const sid = 's3'
    enqueueEvent(sid, JSON.stringify({ seq: 0 }))
    enqueueEvent(sid, JSON.stringify({ seq: 1 }))

    await flushSession(sid)

    const lines = readLines(sid)
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([0, 1])
  })

  it('flushAll drains every session', async () => {
    enqueueEvent('a', JSON.stringify({ seq: 0 }))
    enqueueEvent('b', JSON.stringify({ seq: 0 }))
    enqueueEvent('b', JSON.stringify({ seq: 1 }))

    await flushAll()

    expect(readLines('a')).toHaveLength(1)
    expect(readLines('b')).toHaveLength(2)
  })

  it('tracks flush metrics', async () => {
    __resetForTests()
    enqueueEvent('s-metrics', JSON.stringify({ a: 1 }))
    enqueueEvent('s-metrics', JSON.stringify({ a: 2 }))
    await flushSession('s-metrics')
    const m = getEventWriterMetrics()
    expect(m.flushes).toBe(1)
    expect(m.lines).toBe(2)
    expect(m.bytes).toBeGreaterThan(0)
    expect(m.errors).toBe(0)
  })

  it('drops idle queues', async () => {
    __resetForTests()
    enqueueEvent('s-drop', JSON.stringify({}))
    await flushSession('s-drop')
    expect(hasQueueForTest('s-drop')).toBe(true)
    dropIdleQueues()
    expect(hasQueueForTest('s-drop')).toBe(false)
  })

  it('preserves FIFO order across mixed timer and threshold triggers', async () => {
    const sid = 's4'
    // First enqueue a few to start a timer.
    for (let i = 0; i < 3; i += 1) {
      enqueueEvent(sid, JSON.stringify({ seq: i }))
    }
    // Then push enough to trigger the threshold flush.
    for (let i = 3; i < FLUSH_THRESHOLD + 3; i += 1) {
      enqueueEvent(sid, JSON.stringify({ seq: i }))
    }
    await flushSession(sid)

    const seqs = readLines(sid).map((l) => JSON.parse(l).seq)
    expect(seqs).toEqual(Array.from({ length: FLUSH_THRESHOLD + 3 }, (_, i) => i))
  })
})
