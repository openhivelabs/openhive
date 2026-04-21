/**
 * Built-in web_fetch tool. Fetches a URL and returns stripped text content
 * so the Lead/Researcher can include web material without provisioning a
 * dedicated MCP server.
 *
 * Deliberately dependency-free: a lightweight tag-stripper handles HTML
 * well enough for summarisation without pulling in jsdom + readability.
 * Private-range IPs and non-http(s) schemes are rejected at the boundary.
 */

import type { Tool } from './base'

const WEBFETCH_TIMEOUT_MS = 10_000
const WEBFETCH_MAX_CHARS = 20_000
const WEBFETCH_MAX_BYTES = 2_000_000
const WEBFETCH_USER_AGENT =
  'OpenHive/0.1 (+https://github.com/openhive/openhive)'

/** Narrow test: reject localhost, link-local, loopback, and private RFC1918
 *  ranges. Hostnames are not resolved — we only guard the literal form so a
 *  malicious redirect through a DNS rebinding setup stays possible. The
 *  primary goal is preventing trivial SSRF, not bullet-proof isolation. */
export function isPrivateUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return true
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
  const host = u.hostname.toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host === '0.0.0.0') return true
  if (host.endsWith('.localhost')) return true
  // IPv4 literal checks
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const parts = v4.slice(1).map((p) => Number.parseInt(p, 10))
    if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
    const [a, b] = parts as [number, number, number, number]
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 0) return true
  }
  // IPv6 literal checks (very loose — rejects ::1 and fe80::/10)
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1)
    if (inner === '::1' || inner.startsWith('fe80:')) return true
  }
  return false
}

/** Best-effort HTML → text. Removes script/style wholesale, turns common
 *  block-level tag boundaries into newlines, then strips remaining tags
 *  and collapses whitespace. Not as clean as readability, but keeps the
 *  tool dependency-free. */
export function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<!--([\s\S]*?)-->/g, ' ')
  s = s.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|li|section|article|header|footer|h[1-6])>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  // decode a handful of common entities
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.replace(/[ \t]{2,}/g, ' ')
  return s.trim()
}

export function capText(text: string, origBytes: number): string {
  if (text.length <= WEBFETCH_MAX_CHARS) return text
  const head = text.slice(0, WEBFETCH_MAX_CHARS)
  return (
    `${head}\n\n[openhive:webfetch-truncated] Page body was ${text.length} ` +
    `chars (${origBytes} bytes fetched); showing first ${WEBFETCH_MAX_CHARS}. ` +
    'Narrow the URL (deeper path, query filter) to get more targeted content.'
  )
}

export function webFetchTool(): Tool {
  return {
    name: 'web_fetch',
    description:
      'Fetch an absolute http(s) URL and return its readable text content. ' +
      'HTML noise (scripts, styles, tags) is stripped. Use this when you ' +
      'need to read a web page to summarise or cite it. Private IPs and ' +
      'non-http schemes are rejected.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to fetch.',
        },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const url = typeof (args as { url?: unknown }).url === 'string'
        ? (args as { url: string }).url.trim()
        : ''
      if (!url) return JSON.stringify({ ok: false, error: 'missing url' })
      if (isPrivateUrl(url)) {
        return JSON.stringify({
          ok: false,
          error: 'URL rejected (non-http scheme, localhost, or private IP).',
        })
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), WEBFETCH_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'user-agent': WEBFETCH_USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
        })
        const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
        const buf = await res.arrayBuffer()
        if (buf.byteLength > WEBFETCH_MAX_BYTES) {
          return JSON.stringify({
            ok: false,
            error: `Response exceeded ${WEBFETCH_MAX_BYTES} bytes (${buf.byteLength}).`,
          })
        }
        const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf)
        const text = ctype.includes('html') ? htmlToText(raw) : raw.trim()
        const body = capText(text, buf.byteLength)
        return JSON.stringify({
          ok: res.ok,
          status: res.status,
          content_type: ctype || null,
          url: res.url,
          body,
        })
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc)
        return JSON.stringify({ ok: false, error: message })
      } finally {
        clearTimeout(timer)
      }
    },
    hint: 'Fetching web page…',
  }
}
