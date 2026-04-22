/**
 * Node-runtime-only portion of `instrumentation.ts`. Split into its own
 * module so Turbopack's static analyzer doesn't flag `process.once` as an
 * Edge Runtime incompatibility — the parent file dynamic-imports this only
 * when NEXT_RUNTIME === 'nodejs'.
 */

export async function registerNode() {
  try {
    const { needsMigration, migrateLegacyDb } = await import('./lib/server/legacy-db-migration')
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

  const { backfillTranscripts, markOrphanedSessionsIdle, pruneLegacyArtifactsRoot } = await import(
    './lib/server/sessions'
  )

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

  // Lazy scheduler: instantiate, register persisted scheduled tasks + any
  // team with panel bindings. Tick only runs if at least one routine is
  // registered — an idle server with zero scheduled tasks and zero panels
  // keeps no interval alive.
  try {
    const { getScheduler } = await import('./lib/server/scheduler/scheduler')
    const { listTasks } = await import('./lib/server/tasks')
    const { listCompanies } = await import('./lib/server/companies')
    const { loadDashboard } = await import('./lib/server/dashboards')
    const s = getScheduler()

    let scheduledCount = 0
    try {
      for (const task of listTasks()) {
        if (task.mode !== 'scheduled') continue
        const taskId = typeof task.id === 'string' ? task.id : null
        const cron = typeof task.cron === 'string' ? task.cron : undefined
        if (!taskId || !cron) continue
        s.addRoutine({ id: `task:${taskId}`, cron })
        scheduledCount++
      }
    } catch (exc) {
      console.error('boot: scheduled-task enumeration failed', exc)
    }

    let hasPanels = false
    try {
      outer: for (const company of listCompanies()) {
        const companySlug = typeof company.slug === 'string' ? company.slug : null
        if (!companySlug) continue
        for (const team of company.teams ?? []) {
          const teamSlug = typeof team.slug === 'string' ? team.slug : null
          if (!teamSlug) continue
          const layout = loadDashboard(companySlug, teamSlug)
          if (!layout) continue
          const blocks = Array.isArray(layout.blocks) ? layout.blocks : []
          for (const raw of blocks) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
            if ((raw as Record<string, unknown>).binding) {
              hasPanels = true
              break outer
            }
          }
        }
      }
    } catch (exc) {
      console.error('boot: panel binding scan failed', exc)
    }
    if (hasPanels) s.addRoutine({ id: 'panels:refresh' })

    if (scheduledCount === 0 && !hasPanels) {
      console.log('boot: scheduler idle (no scheduled tasks or panel bindings)')
    } else {
      console.log(`boot: scheduler armed — ${scheduledCount} task(s), panels=${hasPanels}`)
    }
  } catch (exc) {
    console.error('boot: scheduler init failed', exc)
  }

  try {
    const { registerEventWriterShutdown } = await import(
      './lib/server/sessions/event-writer-shutdown'
    )
    registerEventWriterShutdown()
  } catch (exc) {
    console.error('boot: event-writer shutdown hook setup failed', exc)
  }
}
