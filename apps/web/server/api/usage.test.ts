import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/server/usage', () => ({
  usageForSessions: vi.fn((ids: string[]) => ({ sessions: ids })),
  summary: vi.fn((period: string) => ({ period, totalCostCents: 0 })),
}))

const { usage } = await import('./usage')

describe('GET /api/usage/by-session', () => {
  it('parses comma-separated session_ids', async () => {
    const res = await usage.fetch(new Request('http://local/by-session?session_ids=a,b,%20c%20'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: ['a', 'b', 'c'] })
  })

  it('returns empty list when no query', async () => {
    const res = await usage.fetch(new Request('http://local/by-session'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: [] })
  })
})

describe('GET /api/usage/summary', () => {
  it('defaults to all when period missing', async () => {
    const res = await usage.fetch(new Request('http://local/summary'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ period: 'all', totalCostCents: 0 })
  })

  it('accepts valid period', async () => {
    const res = await usage.fetch(new Request('http://local/summary?period=24h'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ period: '24h', totalCostCents: 0 })
  })

  it('rejects invalid period with 422', async () => {
    const res = await usage.fetch(new Request('http://local/summary?period=bogus'))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ detail: "invalid period 'bogus'" })
  })
})
