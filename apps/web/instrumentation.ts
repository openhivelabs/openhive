/**
 * Next.js instrumentation hook. Runs once per server process start (dev
 * reload + prod boot).
 *
 * We use it to launch the scheduler + clean up runs left mid-flight by a
 * crash, mirroring apps/server/openhive/main.py's lifespan hook. Lives in
 * the Node runtime; skipped when Next runs in the edge runtime (we don't).
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // Dynamic imports so the edge runtime never loads better-sqlite3 etc.
  const { startScheduler } = await import('./lib/server/scheduler/scheduler')
  const { markOrphanedRunsInterrupted } = await import('./lib/server/runs-store')
  const { backfillSessions } = await import('./lib/server/sessions')

  try {
    const n = markOrphanedRunsInterrupted()
    if (n > 0) {
      console.log(`boot: marked ${n} orphaned run(s) as interrupted`)
    }
  } catch (exc) {
    console.error('boot: orphan cleanup failed', exc)
  }

  try {
    const n = backfillSessions()
    if (n > 0) {
      console.log(`boot: backfilled ${n} session directory/directories`)
    }
  } catch (exc) {
    console.error('boot: session backfill failed', exc)
  }

  startScheduler()
}
