import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { api } from './api'

const app = new Hono()
app.use('*', logger())
app.route('/api', api)
app.get('/health', (c) => c.json({ ok: true }))

const port = Number.parseInt(process.env.HONO_PORT ?? '4484', 10)
const host = process.env.HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port, hostname: host })
console.log(`[hono] listening on ${host}:${port}`)
