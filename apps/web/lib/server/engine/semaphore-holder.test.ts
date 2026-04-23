import { describe, expect, it } from 'vitest'
import { Semaphore, SemaphoreHolder } from './session'

describe('SemaphoreHolder', () => {
  it('acquires exactly once regardless of repeated calls', async () => {
    const sem = new Semaphore(2)
    const h = new SemaphoreHolder(sem)
    await h.acquire()
    await h.acquire() // no-op
    expect(h.isHeld()).toBe(true)
    expect(sem.inUse()).toBe(1)
  })

  it('release is idempotent', async () => {
    const sem = new Semaphore(2)
    const h = new SemaphoreHolder(sem)
    await h.acquire()
    h.release()
    h.release() // no-op — must not double-free the permit
    expect(h.isHeld()).toBe(false)
    expect(sem.inUse()).toBe(0)
  })

  it('release-then-acquire cycles a single permit cleanly', async () => {
    const sem = new Semaphore(1)
    const h = new SemaphoreHolder(sem)
    await h.acquire()
    h.release()
    await h.acquire()
    h.release()
    expect(sem.inUse()).toBe(0)
  })
})

describe('chat park/reacquire semantics (Bug #2 scenario)', () => {
  it('releases permit while parked so a new session can start', async () => {
    // maxConcurrentRuns = 1 for a tight test. Session A acquires, "parks"
    // by releasing, and session B must be able to start immediately.
    const sem = new Semaphore(1)
    const a = new SemaphoreHolder(sem)
    const b = new SemaphoreHolder(sem)

    await a.acquire()
    expect(sem.inUse()).toBe(1)

    // Simulate turn_finished → release-on-park.
    a.release()
    expect(sem.inUse()).toBe(0)

    // New session B starts without waiting.
    await b.acquire()
    expect(sem.inUse()).toBe(1)

    // A reacquires on follow-up message — must wait until B releases.
    let aReacquired = false
    const aWaiting = a.acquire().then(() => {
      aReacquired = true
    })
    // Yield: B still holds.
    await Promise.resolve()
    expect(aReacquired).toBe(false)

    b.release()
    await aWaiting
    expect(aReacquired).toBe(true)
    expect(sem.inUse()).toBe(1)

    a.release()
    expect(sem.inUse()).toBe(0)
  })

  it('4 sessions serialized through a 3-permit pool never deadlock (Bug #2 regression)', async () => {
    // Repro of the observed failure: 3 idle chat tabs hold all permits
    // forever, the 4th sits in run_queued indefinitely. With the park
    // release, the 4th should be able to proceed as soon as the 1st parks.
    const sem = new Semaphore(3)
    const holders = Array.from({ length: 4 }, () => new SemaphoreHolder(sem))

    // First three grab permits (fresh start).
    await holders[0]!.acquire()
    await holders[1]!.acquire()
    await holders[2]!.acquire()
    expect(sem.inUse()).toBe(3)

    // All three finish their first turn and park → release permits.
    holders[0]!.release()
    holders[1]!.release()
    holders[2]!.release()
    expect(sem.inUse()).toBe(0)

    // Fourth session starts — would have been stuck in run_queued under
    // the old code; now acquires immediately.
    await holders[3]!.acquire()
    expect(sem.inUse()).toBe(1)

    // Cleanup.
    holders[3]!.release()
    expect(sem.inUse()).toBe(0)
  })
})
