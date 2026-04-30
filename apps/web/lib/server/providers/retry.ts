/**
 * Exponential backoff for transient provider errors (429, 529, 5xx, network).
 *
 * Extracted from the inline retry loop in `claude.ts:streamMessages` so all
 * adapters can share the same policy. Defaults match the original Claude
 * loop: 2 retries, ~6s + ~18s, ≤30s total.
 */

export interface RetryOpts {
  /** Total attempts including the first. Default 3 (= 2 retries). */
  maxAttempts?: number
  /** Base wait per retry in ms. attempt N waits roughly `baseMs * N` + jitter. */
  baseMs?: number
  /** Honor `Retry-After` / `retry-after` header on 429 if present. */
  on429RespectHeader?: boolean
  /** Decide whether a Response is retriable. Default: 429/529/5xx. */
  isRetriable?: (resp: Response) => boolean
}

const DEFAULT_RETRIABLE = (resp: Response): boolean =>
  resp.status === 429 ||
  resp.status === 529 ||
  (resp.status >= 500 && resp.status <= 599)

/**
 * Run `fn` up to `maxAttempts` times with backoff between retriable failures.
 * Returns the final `Response` (which may itself be a non-retriable error).
 *
 * Caller decides what to do with non-2xx responses — this function only
 * coordinates the retry loop and drains the body of each retried response
 * so sockets don't leak.
 */
export async function retryWithBackoff(
  fn: () => Promise<Response>,
  opts: RetryOpts = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseMs = opts.baseMs ?? 6000
  const isRetriable = opts.isRetriable ?? DEFAULT_RETRIABLE

  let attempt = 0
  let resp: Response
  while (true) {
    resp = await fn()
    if (resp.ok) return resp
    attempt += 1
    if (attempt >= maxAttempts || !isRetriable(resp)) return resp

    // Drain body to avoid socket leak.
    try {
      await resp.text()
    } catch {
      /* ignore */
    }

    let waitMs = baseMs * attempt + Math.floor(Math.random() * 2000)
    if (opts.on429RespectHeader && resp.status === 429) {
      const ra = resp.headers.get('retry-after') ?? resp.headers.get('Retry-After')
      const raSec = ra ? Number.parseInt(ra, 10) : NaN
      if (Number.isFinite(raSec) && raSec > 0 && raSec < 120) {
        waitMs = raSec * 1000
      }
    }
    await new Promise((r) => setTimeout(r, waitMs))
  }
}
