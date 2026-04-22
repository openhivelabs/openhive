import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { api } from './api'

const startTime = Date.now()

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
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
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
