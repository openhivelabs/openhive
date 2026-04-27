import { readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { migrateAllAgents } from '@/lib/server/agents/scaffold'
import { callbackHtml, handleCallback } from '@/lib/server/auth/orchestrator'
import { ensurePython } from '@/lib/server/python-bootstrap'
import { migrateTeamDbsToCompany } from '../scripts/migrate-team-db-to-company'
import { registerNode } from '../instrumentation-node'
import { api } from './api'

const startTime = Date.now()

// Fire-and-forget boot tasks: legacy DB migration, orphan session cleanup,
// transcript backfill, scheduler, signal handlers. Previously wired via
// Next's `instrumentation.ts` hook — now invoked directly.
void registerNode().catch((exc) => {
  console.error('[hono] registerNode failed', exc)
})

// First-boot Python doctor — provisions ~/.openhive/python-venv with every
// third-party module the skill subprocesses need (openpyxl, python-docx,
// python-pptx, reportlab, pypdf, lxml, jsonschema, httpx, jinja2, pyyaml).
// Idempotent and fail-soft: a missing python interpreter or pip failure
// only blocks Python-backed skills, not the server itself.
void ensurePython().catch((exc) => {
  console.error('[hono] python bootstrap failed', exc)
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

// One-shot migration: merge per-team data.db files into a single company DB
// with a team_id soft namespace. Idempotent — a no-op once a company has
// already been migrated. See apps/web/scripts/migrate-team-db-to-company.ts.
try {
  migrateTeamDbsToCompany()
} catch (exc) {
  console.error('[hono] team→company DB migration failed', exc)
}

const app = new Hono()
app.use('*', logger())

// API routes MUST be registered BEFORE static + SPA fallback so SSE/long-poll
// endpoints aren't intercepted by the static handler.
app.route('/api', api)
app.get('/health', (c) => c.json({ ok: true }))

// OAuth callback landing pages. Mounted at the ROOT (not under /api) so the
// redirect_uri we register with Anthropic (`/callback`) and OpenAI Codex
// (`/auth/callback`) matches the paths their shared CLI client_ids accept.
// We used to redirect to `/api/providers/oauth/callback`, but both providers
// reject that path with a generic error before the user ever sees the login
// screen. Both handlers delegate to the same `handleCallback` — the only
// difference is which URL the provider will redirect the browser to.
for (const callbackPath of ['/callback', '/auth/callback'] as const) {
  app.get(callbackPath, async (c) => {
    const params = new URL(c.req.url).searchParams
    const result = await handleCallback({
      code: params.get('code'),
      state: params.get('state'),
      // Legacy fallback: older flows also passed `flow_id` as a separate
      // query param. Modern flows embed it inside `state` and this is null.
      flowId: params.get('flow_id'),
      error: params.get('error'),
      errorDescription: params.get('error_description'),
    })
    return new Response(callbackHtml(result.ok, result.message), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  })
}

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
