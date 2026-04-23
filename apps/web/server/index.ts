import { readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { migrateAllAgents } from '@/lib/server/agents/scaffold'
import { registerNode } from '../instrumentation-node'
import { api } from './api'

const startTime = Date.now()

// Fire-and-forget boot tasks: legacy DB migration, orphan session cleanup,
// transcript backfill, scheduler, signal handlers. Previously wired via
// Next's `instrumentation.ts` hook — now invoked directly.
void registerNode().catch((exc) => {
  console.error('[hono] registerNode failed', exc)
})

// One-shot migration: agents created before the AGENT.md-first refactor may
// still live as inline system_prompt in team.yaml. Scaffold bundles for them
// so every agent shares the same on-disk shape. Idempotent.
try {
  const { scanned, migrated, limits_bumped } = migrateAllAgents()
  if (migrated > 0) {
    console.log(`[hono] agent migration: scaffolded ${migrated}/${scanned} agents`)
  }
  if (limits_bumped > 0) {
    console.log(`[hono] team migration: bumped max_tool_rounds_per_turn on ${limits_bumped} team(s)`)
  }
} catch (exc) {
  console.error('[hono] agent migration failed', exc)
}

const app = new Hono()
app.use('*', logger())

// API routes MUST be registered BEFORE static + SPA fallback so SSE/long-poll
// endpoints aren't intercepted by the static handler.
app.route('/api', api)
app.get('/health', (c) => c.json({ ok: true }))

const isProd = process.env.NODE_ENV === 'production'

if (isProd) {
  // After `tsc` emits to apps/web/dist-server/server/index.js, the Vite build
  // output lives at apps/web/dist (one level up from dist-server/server).
  // __dirname is available at runtime (CommonJS emit).
  const distDir = path.resolve(__dirname, '../../dist')

  // Serve static assets from dist/. `root` is interpreted relative to CWD,
  // so we also provide a manual fallback using absolute paths below.
  app.use(
    '/*',
    serveStatic({
      root: path.relative(process.cwd(), distDir) || '.',
    }),
  )

  // SPA fallback — any unmatched GET returns index.html so React Router can
  // take over client-side routing.
  app.get('*', (c) => {
    const html = readFileSync(path.join(distDir, 'index.html'), 'utf8')
    return c.html(html)
  })
}

const port = Number.parseInt(
  process.env.PORT ?? (isProd ? '4483' : '4484'),
  10,
)
const host = process.env.HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port, hostname: host })
console.log(
  `[hono] ready in ${Date.now() - startTime}ms (listening on ${host}:${port}, prod=${isProd})`,
)
