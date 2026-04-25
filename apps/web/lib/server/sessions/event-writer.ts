/**
 * Per-session async event writer with batching.
 *
 * Event lines enter a per-session FIFO buffer. A flush is triggered whenever
 * the buffer reaches FLUSH_THRESHOLD entries OR a FLUSH_INTERVAL_MS timer
 * elapses after the first pending enqueue — whichever comes first. Flushes
 * for a given session are serialized via a chained promise so disk order
 * matches enqueue order (preserving seq monotonicity).
 *
 * SSE fan-out is independent of this path: the engine pushes events to
 * listener queues directly. Losing at most one batch's worth of pending
 * lines on crash is acceptable; replay detects gaps via seq.
 *
 * Spec: docs/superpowers/specs/2026-04-22-event-write-batching.md
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { sessionsRoot } from '../paths'

/** @deprecated use flushIntervalMs() */
export const FLUSH_INTERVAL_MS = 100
/** @deprecated use flushThreshold() */
export const FLUSH_THRESHOLD = 10

/** Read flush interval (ms) from env each call. Invalid/≤0 → 100. */
export function flushIntervalMs(): number {
  const v = Number.parseInt(process.env.OPENHIVE_EVENT_FLUSH_INTERVAL_MS ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 100
}

/** Read flush threshold from env each call. Invalid/≤0 → 10. */
export function flushThreshold(): number {
  const v = Number.parseInt(process.env.OPENHIVE_EVENT_FLUSH_THRESHOLD ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 10
}

const metrics = {
  flushes: 0,
  lines: 0,
  bytes: 0,
  errors: 0,
  /** Counts of times we detected a session whose dir disappeared mid-run
   *  and dropped its pending events instead of recreating an empty path. */
  dropped_missing_dir: 0,
}

/** Sessions whose dir was observed missing during a flush — we stop
 *  recreating the path and drop all pending/future events for them.
 *  Cleared only by `__resetEventWriter` (test helper). */
const disappeared = new Set<string>()

/** Snapshot of flush metrics (flushes, total lines, total bytes, error count). */
export function getEventWriterMetrics(): {
  flushes: number
  lines: number
  bytes: number
  errors: number
  dropped_missing_dir: number
} {
  return { ...metrics }
}

interface Queue {
  buf: string[]
  timer: NodeJS.Timeout | null
  /** Chain of in-flight flushes. Each new flush awaits the previous one,
   *  so append order on disk matches enqueue order even across concurrent
   *  triggers (timer fires + threshold hit at the same tick). */
  flushing: Promise<void>
}

const queues = new Map<string, Queue>()

/** Resolver to plug in a custom path (tests); defaults to the real sessions
 *  layout. Avoids a circular import against `../sessions.ts`. */
let pathResolver: (sessionId: string) => string = (sessionId) =>
  path.join(sessionsRoot(), sessionId, 'events.jsonl')

/** For tests: override the events-file resolver. */
export function __setPathResolver(fn: (sessionId: string) => string): void {
  pathResolver = fn
}

function ensureQueue(sessionId: string): Queue {
  let q = queues.get(sessionId)
  if (!q) {
    q = { buf: [], timer: null, flushing: Promise.resolve() }
    queues.set(sessionId, q)
  }
  return q
}

/** Queue a single JSONL row (no trailing newline) for async append. */
export function enqueueEvent(sessionId: string, rowJsonl: string): void {
  // Session dir was deleted mid-run — drop everything to keep us from
  // resurrecting an empty path with `mkdir({recursive:true})`. The
  // engine's run loop is signalled to abort by the same code path that
  // first detected the disappearance (see `markDisappeared`).
  if (disappeared.has(sessionId)) {
    metrics.dropped_missing_dir += 1
    return
  }
  const q = ensureQueue(sessionId)
  q.buf.push(rowJsonl)

  if (q.buf.length >= flushThreshold()) {
    if (q.timer) {
      clearTimeout(q.timer)
      q.timer = null
    }
    void triggerFlush(sessionId)
    return
  }

  if (!q.timer) {
    q.timer = setTimeout(() => {
      const cur = queues.get(sessionId)
      if (cur) cur.timer = null
      void triggerFlush(sessionId)
    }, flushIntervalMs())
    // Don't block process shutdown on the timer; flushAll() drains on SIGTERM.
    q.timer.unref?.()
  }
}

function triggerFlush(sessionId: string): Promise<void> {
  const q = queues.get(sessionId)
  if (!q) return Promise.resolve()
  const next = q.flushing.then(() => doFlush(sessionId))
  q.flushing = next.catch(() => {
    /* swallow — errors logged below; don't poison the chain */
  })
  return next
}

async function doFlush(sessionId: string): Promise<void> {
  const q = queues.get(sessionId)
  if (!q || q.buf.length === 0) return
  const lines = q.buf
  q.buf = []
  const payload = `${lines.join('\n')}\n`
  const filePath = pathResolver(sessionId)
  // If the session's parent dir is gone but its sibling `meta.json` is
  // also gone, the user (or a test) deleted the session out from under
  // us. Refuse to recreate the path — recreating with mkdir(recursive)
  // would resurrect an empty session dir and silently leak future
  // events into orphaned storage. Instead, mark it disappeared, fire
  // an abort signal toward the engine (lazy import to dodge the
  // event-writer ↔ session-registry circular), drop these lines.
  const dir = path.dirname(filePath)
  const metaPath = path.join(dir, 'meta.json')
  if (!fs.existsSync(metaPath)) {
    metrics.dropped_missing_dir += lines.length
    markDisappeared(sessionId)
    return
  }
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.appendFile(filePath, payload, 'utf8')
    metrics.flushes += 1
    metrics.lines += lines.length
    metrics.bytes += Buffer.byteLength(payload, 'utf8')
  } catch (exc) {
    // Fallback: try to write synchronously so we don't silently lose data.
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(filePath, payload, 'utf8')
      metrics.flushes += 1
      metrics.lines += lines.length
      metrics.bytes += Buffer.byteLength(payload, 'utf8')
    } catch (exc2) {
      metrics.errors += 1
      console.error('event-writer: flush failed', sessionId, exc, exc2)
    }
  }
}

/** Tag a session as gone, fire-and-forget the engine abort, drop its
 *  in-memory queue. Idempotent. */
function markDisappeared(sessionId: string): void {
  if (disappeared.has(sessionId)) return
  disappeared.add(sessionId)
  const q = queues.get(sessionId)
  if (q) {
    if (q.timer) {
      clearTimeout(q.timer)
      q.timer = null
    }
    q.buf = []
  }
  console.warn(
    `event-writer: session dir disappeared mid-run, aborting (${sessionId})`,
  )
  // Lazy dynamic import — session-registry imports back into engine
  // glue that imports this file, so a top-level import would create a
  // cycle. Errors swallowed: the queue is already dropped, so even if
  // the abort never reaches the registry the session's writes are
  // contained.
  void import('@/lib/server/engine/session-registry')
    .then((m) => m.stop(sessionId))
    .catch(() => {
      /* registry not ready / stop failed — queue drop is sufficient */
    })
}

/** Drop sessions whose queues are empty and have no pending timer.
 *  Used by session finalize paths to keep the queue map bounded. */
export function dropIdleQueues(): void {
  for (const [id, q] of queues) {
    if (q.buf.length === 0 && !q.timer) queues.delete(id)
  }
}

/** Test helper: presence check for a given session's queue. */
export function hasQueueForTest(id: string): boolean {
  return queues.has(id)
}

/** Drain any pending events for one session. Resolves once the last
 *  currently-queued batch has hit disk. */
export async function flushSession(sessionId: string): Promise<void> {
  const q = queues.get(sessionId)
  if (!q) return
  if (q.timer) {
    clearTimeout(q.timer)
    q.timer = null
  }
  await triggerFlush(sessionId)
  // Await the chained flush so everything enqueued up to this call is durable.
  await q.flushing
}

/** Drain all sessions. Used from the SIGTERM hook. */
export async function flushAll(): Promise<void> {
  const ids = [...queues.keys()]
  await Promise.all(ids.map((id) => flushSession(id)))
}

/** Test helper: reset in-memory state. */
export function __resetForTests(): void {
  for (const q of queues.values()) {
    if (q.timer) clearTimeout(q.timer)
  }
  queues.clear()
  disappeared.clear()
  metrics.flushes = 0
  metrics.lines = 0
  metrics.bytes = 0
  metrics.errors = 0
  metrics.dropped_missing_dir = 0
}
