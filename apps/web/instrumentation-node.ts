/**
 * Node-runtime-only portion of `instrumentation.ts`. Split into its own
 * module so Turbopack's static analyzer doesn't flag `process.once` as an
 * Edge Runtime incompatibility — the parent file dynamic-imports this only
 * when NEXT_RUNTIME === 'nodejs'.
 */

export async function registerNode() {
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
    backfillTranscripts,
    markOrphanedSessionsIdle,
    pruneLegacyArtifactsRoot,
  } = await import('./lib/server/sessions')

  try {
    const n = await markOrphanedSessionsIdle()
    if (n > 0) {
      console.log(`boot: demoted ${n} orphaned running session(s) to idle (resumable)`)
    }
  } catch (exc) {
    console.error('boot: orphan cleanup failed', exc)
  }

  try {
    const n = backfillTranscripts()
    if (n > 0) console.log(`boot: backfilled ${n} transcript(s) from events.jsonl`)
  } catch (exc) {
    console.error('boot: transcript backfill failed', exc)
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

  try {
    const { flushAll } = await import('./lib/server/sessions/event-writer')
    const shutdown = async (signal: string) => {
      try {
        await flushAll()
      } catch (exc) {
        console.error(`shutdown (${signal}): event flush failed`, exc)
      }
    }
    process.once('SIGTERM', () => { void shutdown('SIGTERM') })
    process.once('SIGINT', () => { void shutdown('SIGINT') })
    process.once('beforeExit', () => { void shutdown('beforeExit') })
  } catch (exc) {
    console.error('boot: event-writer shutdown hook setup failed', exc)
  }
}
