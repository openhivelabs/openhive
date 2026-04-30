import { describe, expect, it, vi } from 'vitest'
import { retryWithBackoff } from './retry'

const okResponse = (status: number, body = '') =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } })

describe('retryWithBackoff', () => {
  it('returns the first 2xx response without retrying', async () => {
    const fn = vi.fn(() => Promise.resolve(okResponse(200)))
    const r = await retryWithBackoff(fn)
    expect(r.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 then succeeds', async () => {
    let calls = 0
    const fn = vi.fn(() => {
      calls += 1
      return Promise.resolve(okResponse(calls < 2 ? 429 : 200))
    })
    const r = await retryWithBackoff(fn, { baseMs: 1, maxAttempts: 3 })
    expect(r.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on 5xx then surfaces last failure', async () => {
    const fn = vi.fn(() => Promise.resolve(okResponse(503)))
    const r = await retryWithBackoff(fn, { baseMs: 1, maxAttempts: 3 })
    expect(r.status).toBe(503)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-retriable status (400)', async () => {
    const fn = vi.fn(() => Promise.resolve(okResponse(400)))
    const r = await retryWithBackoff(fn, { baseMs: 1, maxAttempts: 3 })
    expect(r.status).toBe(400)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After header on 429 when on429RespectHeader=true', async () => {
    let calls = 0
    const fn = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve(
          new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } }),
        )
      }
      return Promise.resolve(okResponse(200))
    })
    const t0 = Date.now()
    const r = await retryWithBackoff(fn, {
      baseMs: 9999, // would be far longer than the header value
      maxAttempts: 2,
      on429RespectHeader: true,
    })
    expect(r.status).toBe(200)
    // Should have waited ~1000ms, never the 9999ms baseMs
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})
