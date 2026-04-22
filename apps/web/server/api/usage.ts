import { type UsagePeriod, summary, usageForSessions } from '@/lib/server/usage'
import { Hono } from 'hono'

export const usage = new Hono()

const VALID_PERIODS: readonly UsagePeriod[] = ['24h', '7d', '30d', 'all'] as const

// GET /api/usage/by-session?session_ids=a,b,c
usage.get('/by-session', (c) => {
  const raw = c.req.query('session_ids') ?? ''
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return c.json(usageForSessions(ids))
})

// GET /api/usage/summary?period=24h|7d|30d|all
usage.get('/summary', (c) => {
  const raw = c.req.query('period') ?? 'all'
  const period = (VALID_PERIODS as readonly string[]).includes(raw) ? (raw as UsagePeriod) : null
  if (!period) {
    return c.json({ detail: `invalid period '${raw}'` }, 422)
  }
  return c.json(summary(period))
})
