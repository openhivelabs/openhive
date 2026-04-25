/**
 * Per-team serialization lock for panel installs.
 *
 * The install pipeline is idempotent + transactional per statement, but
 * concurrent installs on the same team can still produce stale plans:
 * install A previews schema S1, then install B applies before A,
 * bringing schema to S2 — A's alter_sql is now computed against an
 * out-of-date snapshot. The panel UI prevents this client-side by
 * disabling the button during install, but the server needs its own
 * guard for direct API callers + future multi-tab users.
 *
 * Simple in-process mutex keyed by teamId. Apply calls wait in FIFO
 * order; preview calls never take the lock (they have no side effects).
 *
 * In a future multi-process deploy, replace with a DB-backed lock row
 * in `openhive.db`. For the single-process dev + MVP shipping shape,
 * this is enough.
 */

type Release = () => void

const queues = new Map<string, Promise<void>>()

/** Acquire the team's install lock. Returns a `release` callback the
 *  caller must invoke in a finally block. Subsequent acquires for the
 *  same team wait until `release` fires. */
export async function acquireInstallLock(teamId: string): Promise<Release> {
  const prev = queues.get(teamId) ?? Promise.resolve()
  let release: Release = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  // Chain the new tail onto the old one. Clear from the map only when
  // we're the last waiter (no-one else enqueued after us).
  const tail = prev.then(() => current)
  queues.set(teamId, tail)
  await prev
  return () => {
    release()
    // Best-effort cleanup: if our tail is still the head, drop the
    // entry so the map doesn't grow unboundedly.
    if (queues.get(teamId) === tail) {
      queues.delete(teamId)
    }
  }
}
