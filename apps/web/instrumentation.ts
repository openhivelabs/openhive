/**
 * Next.js instrumentation hook. Runs once per server process start (dev
 * reload + prod boot).
 *
 * We use it to launch the scheduler + clean up sessions left mid-flight by a
 * crash, mirroring apps/server/openhive/main.py's lifespan hook. Lives in
 * the Node runtime; skipped when Next runs in the edge runtime (we don't).
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Legacy DB → FS migration. Must run before the FS-only stores try to read
  // anything, because sessions/usage/artifacts all live in per-session files
  // after this point.
  try {
    const { needsMigration, migrateLegacyDb } = await import(
      './lib/server/legacy-db-migration'
    )
    if (needsMigration()) {
      const counts = migrateLegacyDb()
      console.log(
        `boot: legacy DB migrated — ${counts.sessions} sessions, ${counts.events} events, ` +
        `${counts.artifacts} artifacts, ${counts.usageRows} usage rows, ` +
        `${counts.messages} messages, ${counts.panels} panels, ${counts.oauth} oauth`,
      )
    }
  } catch (exc) {
    console.error('boot: legacy DB migration failed', exc)
  }

  const { startScheduler } = await import('./lib/server/scheduler/scheduler')
  const {
    markOrphanedSessionsInterrupted,
    pruneLegacyArtifactsRoot,
  } = await import('./lib/server/sessions')

  try {
    const n = markOrphanedSessionsInterrupted()
    if (n > 0) {
      console.log(`boot: marked ${n} orphaned session(s) as interrupted`)
    }
  } catch (exc) {
    console.error('boot: orphan cleanup failed', exc)
  }

  try {
    pruneLegacyArtifactsRoot()
  } catch (exc) {
    console.error('boot: legacy artifact cleanup failed', exc)
  }

  try {
    const { migrateTaskYamls } = await import('./lib/server/tasks')
    const { migrated, scanned } = migrateTaskYamls()
    if (migrated > 0) {
      console.log(`boot: migrated ${migrated}/${scanned} task YAML(s) runs→sessions`)
    }
  } catch (exc) {
    console.error('boot: task YAML migration failed', exc)
  }

  startScheduler()
}
