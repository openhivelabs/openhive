import { describe, expect, it } from 'vitest'
import { __resetSchedulerForTests, getScheduler, hasSchedulerForTest } from './scheduler'

describe('getScheduler (lazy singleton)', () => {
  it('lazily instantiates on first call', () => {
    __resetSchedulerForTests()
    expect(hasSchedulerForTest()).toBe(false)
    getScheduler()
    expect(hasSchedulerForTest()).toBe(true)
  })

  it('returns the same singleton across calls', () => {
    __resetSchedulerForTests()
    const a = getScheduler()
    const b = getScheduler()
    expect(a).toBe(b)
  })

  it('is idle with zero routines', () => {
    __resetSchedulerForTests()
    const s = getScheduler()
    expect(s.isRunningForTest()).toBe(false)
    expect(s.routineCountForTest()).toBe(0)
  })

  it('starts the tick when the first routine is added', () => {
    __resetSchedulerForTests()
    const s = getScheduler()
    s.addRoutine({ id: 'r1', cron: '* * * * *' })
    expect(s.isRunningForTest()).toBe(true)
    expect(s.routineCountForTest()).toBe(1)
    s.stop()
  })

  it('stops the tick when the last routine is removed', () => {
    __resetSchedulerForTests()
    const s = getScheduler()
    s.addRoutine({ id: 'r1', cron: '* * * * *' })
    s.addRoutine({ id: 'r2', cron: '*/5 * * * *' })
    expect(s.isRunningForTest()).toBe(true)
    s.removeRoutine('r1')
    expect(s.isRunningForTest()).toBe(true)
    s.removeRoutine('r2')
    expect(s.isRunningForTest()).toBe(false)
  })

  it('does not double-start when the same routine id is added twice', () => {
    __resetSchedulerForTests()
    const s = getScheduler()
    s.addRoutine({ id: 'r1' })
    const firstRunning = s.isRunningForTest()
    s.addRoutine({ id: 'r1' })
    expect(firstRunning).toBe(true)
    expect(s.isRunningForTest()).toBe(true)
    expect(s.routineCountForTest()).toBe(1)
    s.removeRoutine('r1')
    expect(s.isRunningForTest()).toBe(false)
  })
})
