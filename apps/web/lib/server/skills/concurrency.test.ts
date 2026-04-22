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
})
