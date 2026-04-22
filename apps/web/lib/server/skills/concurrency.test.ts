import { beforeEach, describe, expect, it } from 'vitest'
import { __resetForTests, acquireSkillSlot } from './concurrency'

describe('skill concurrency', () => {
  beforeEach(() => __resetForTests())

  it('limits concurrent tasks to OPENHIVE_PYTHON_CONCURRENCY', async () => {
    process.env.OPENHIVE_PYTHON_CONCURRENCY = '2'
    __resetForTests()
    let active = 0
    let peak = 0
    const run = () =>
      acquireSkillSlot(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
      })
    await Promise.all([run(), run(), run(), run(), run()])
    expect(peak).toBe(2)
  })

  it('preserves return value', async () => {
    process.env.OPENHIVE_PYTHON_CONCURRENCY = undefined
    __resetForTests()
    const v = await acquireSkillSlot(async () => 42)
    expect(v).toBe(42)
  })

  it('default falls back when env unset', () => {
    process.env.OPENHIVE_PYTHON_CONCURRENCY = undefined
    __resetForTests()
    expect(() => acquireSkillSlot(async () => 1)).not.toThrow()
  })

  it('fires onQueued synchronously before the limiter awaits', async () => {
    process.env.OPENHIVE_PYTHON_CONCURRENCY = '2'
    __resetForTests()
    let queuedAt = -1
    let tick = 0
    const before = tick++
    const p = acquireSkillSlot(async () => 'ok', {
      onQueued: () => {
        queuedAt = tick++
      },
    })
    // onQueued must have fired before we hand control back to the event loop.
    expect(queuedAt).toBe(before + 1)
    await p
  })

  it('fires onStarted only after slot is acquired under contention', async () => {
    process.env.OPENHIVE_PYTHON_CONCURRENCY = '1'
    __resetForTests()
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const first = acquireSkillSlot(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
      {
        onQueued: () => order.push('q1'),
        onStarted: () => order.push('s1'),
      },
    )
    // Give the limiter a tick so the first callback is actually scheduled.
    await new Promise((r) => setTimeout(r, 5))

    const second = acquireSkillSlot(async () => 'done', {
      onQueued: () => order.push('q2'),
      onStarted: () => order.push('s2'),
    })
    // Let microtasks flush; second should be queued but not started yet.
    await new Promise((r) => setTimeout(r, 5))
    expect(order).toEqual(['q1', 's1', 'q2'])

    releaseFirst()
    await first
    await second
    expect(order).toEqual(['q1', 's1', 'q2', 's2'])
  })

  it('fires onQueued + onStarted back-to-back when slot is free', async () => {
    process.env.OPENHIVE_PYTHON_CONCURRENCY = '4'
    __resetForTests()
    const order: string[] = []
    await acquireSkillSlot(async () => 'ok', {
      onQueued: () => order.push('queued'),
      onStarted: () => order.push('started'),
    })
    expect(order).toEqual(['queued', 'started'])
  })
})
