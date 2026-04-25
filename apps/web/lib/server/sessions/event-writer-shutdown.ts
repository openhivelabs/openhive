/**
 * Drain the event-writer on process shutdown AND tag in-flight sessions as
 * `abandoned` with a `graceful_shutdown_during_turn` reason so the next
 * boot's reconciliation has the cleanest possible signal. Without this
 * step, a SIGTERM during a turn looks identical to kill -9 — both leave
 * meta.status='running' with no terminal event, and the user can't tell
 * "I rebooted the server" apart from "the agent crashed".
 *
 * Idempotent — safe to call multiple times (and across Next's dev HMR) via
 * a globalThis-keyed flag.
 */
import { markRunningSessionsAbandonedSync } from '../sessions'
import { flushAll } from './event-writer'

const KEY = Symbol.for('openhive.eventWriter.shutdownRegistered')
type G = typeof globalThis & { [k: symbol]: boolean | undefined }

export function registerEventWriterShutdown(): void {
  const g = globalThis as G
  if (g[KEY]) return
  g[KEY] = true

  const shutdown = async (): Promise<void> => {
    // Mark in-flight sessions BEFORE flushing — the meta write is sync and
    // takes ms; the event flush has the 2s race budget. Order matters
    // because we want the abandoned tag durable even if the event flush
    // doesn't finish in time.
    try {
      const n = markRunningSessionsAbandonedSync()
      if (n > 0) {
        console.log(`shutdown: tagged ${n} in-flight session(s) as abandoned`)
      }
    } catch (exc) {
      console.error('shutdown: failed to tag in-flight sessions', exc)
    }
    try {
      await Promise.race([flushAll(), new Promise<void>((r) => setTimeout(r, 2000))])
    } catch {
      // best effort
    }
  }
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0))
  })
  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0))
  })
  process.on('beforeExit', () => {
    void shutdown()
  })
}
