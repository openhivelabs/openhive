/**
 * Tiny FIFO semaphore for provider-level concurrency caps.
 *
 * Use case: Vertex AI region quotas are tight (per-project/per-region
 * limits often around 5-10 RPS for the gemini-3 preview models). A
 * burst of parallel `delegate_parallel` children running on Vertex
 * trips 429 immediately; we cap inflight calls per provider so the
 * remainder queues client-side rather than firing into a 429 wall.
 *
 * No external dependency. Constructor takes `max` concurrent slots;
 * `acquire()` returns a release function the caller invokes (typically
 * in a `finally`) when done.
 */

export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(public readonly max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`Semaphore max must be >=1 (got ${max})`)
    }
  }

  /** Block until a slot is free, then return a release function. */
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active += 1
    return () => this.release()
  }

  private release(): void {
    this.active -= 1
    const next = this.waiters.shift()
    if (next) next()
  }

  /** Inspection helpers for tests / observability. */
  get inflight(): number {
    return this.active
  }
  get queued(): number {
    return this.waiters.length
  }
}
