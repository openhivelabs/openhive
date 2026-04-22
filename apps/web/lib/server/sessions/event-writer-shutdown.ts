/**
 * Drain the event-writer on process shutdown so buffered events hit disk
 * before exit. Idempotent — safe to call multiple times (and across Next's
 * dev HMR) via a globalThis-keyed flag.
 */
import { flushAll } from './event-writer'

const KEY = Symbol.for('openhive.eventWriter.shutdownRegistered')
type G = typeof globalThis & { [k: symbol]: boolean | undefined }

export function registerEventWriterShutdown(): void {
  const g = globalThis as G
  if (g[KEY]) return
  g[KEY] = true

  const drain = async (): Promise<void> => {
    try {
      await Promise.race([flushAll(), new Promise<void>((r) => setTimeout(r, 2000))])
    } catch {
      // best effort
    }
  }
  process.on('SIGTERM', () => {
    void drain().finally(() => process.exit(0))
  })
  process.on('SIGINT', () => {
    void drain().finally(() => process.exit(0))
  })
  process.on('beforeExit', () => {
    void drain()
  })
}
