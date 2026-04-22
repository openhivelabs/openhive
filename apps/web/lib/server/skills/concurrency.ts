/**
 * Global concurrency limiter for Python skill subprocesses.
 *
 * Python cold-start is expensive; letting dozens of subprocesses race each
 * other for CPU + memory slows every one of them down. A single shared
 * limiter caps in-flight Python subprocesses across the whole Node process.
 *
 * Default: clamp(os.cpus().length, 2, 4). Override via
 * `OPENHIVE_PYTHON_CONCURRENCY`. Lives on globalThis so Next dev HMR doesn't
 * duplicate the limiter (per CLAUDE.md singleton rule).
 */

import os from 'node:os'
import pLimit, { type LimitFunction } from 'p-limit'

const GLOBAL_KEY = Symbol.for('openhive.skills.pythonLimiter')
type G = typeof globalThis & { [key: symbol]: LimitFunction | undefined }

function make(): LimitFunction {
  const raw = process.env.OPENHIVE_PYTHON_CONCURRENCY
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  const n =
    Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(2, Math.min(os.cpus().length, 4))
  return pLimit(n)
}

export function skillLimiter(): LimitFunction {
  const g = globalThis as G
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = make()
  return g[GLOBAL_KEY] as LimitFunction
}

/** Hooks for observing slot lifecycle. `onQueued` fires synchronously before
 *  the limiter is awaited (always, even if the slot is free). `onStarted`
 *  fires inside the limiter callback right before `fn` runs — i.e. once the
 *  slot has been acquired. With no contention both fire back-to-back; under
 *  contention there's a gap while the caller waits in the FIFO queue. The
 *  engine uses these to emit `skill.queued` + `skill.started` events so the
 *  UI can show queue state. */
export interface SkillSlotHooks {
  onQueued?: () => void
  onStarted?: () => void
}

export function acquireSkillSlot<T>(fn: () => Promise<T>, hooks?: SkillSlotHooks): Promise<T> {
  hooks?.onQueued?.()
  return skillLimiter()(async () => {
    hooks?.onStarted?.()
    return fn()
  })
}

export function __resetForTests(): void {
  const g = globalThis as G
  g[GLOBAL_KEY] = undefined
}
