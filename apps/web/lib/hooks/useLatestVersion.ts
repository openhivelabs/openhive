import { useEffect, useState } from 'react'
import pkg from '../../package.json'

const RELEASES_URL = 'https://api.github.com/repos/openhivelabs/openhive/releases/latest'
const CACHE_KEY = 'openhive:latestVersion'
const CACHE_TTL_MS = 60 * 60 * 1000

interface CachedVersion {
  tag: string
  htmlUrl: string
  fetchedAt: number
}

interface LatestVersionState {
  current: string
  latest: string | null
  releaseUrl: string | null
  hasUpdate: boolean
}

function parseSemver(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').split('.').map((p) => Number.parseInt(p, 10) || 0)
  return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0]
}

function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest)
  const b = parseSemver(current)
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! > b[i]!) return true
    if (a[i]! < b[i]!) return false
  }
  return false
}

export function useLatestVersion(): LatestVersionState {
  const current = pkg.version
  const [latest, setLatest] = useState<{ tag: string; htmlUrl: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (raw) {
        const cached = JSON.parse(raw) as CachedVersion
        if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          setLatest({ tag: cached.tag, htmlUrl: cached.htmlUrl })
          return
        }
      }
    } catch {
      // ignore parse errors, fall through to fetch
    }
    fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { tag_name?: string; html_url?: string } | null) => {
        if (cancelled || !data?.tag_name) return
        const next = { tag: data.tag_name, htmlUrl: data.html_url ?? '' }
        setLatest(next)
        try {
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ ...next, fetchedAt: Date.now() } satisfies CachedVersion),
          )
        } catch {
          // ignore quota errors
        }
      })
      .catch(() => {
        // offline / rate-limited — silent
      })
    return () => {
      cancelled = true
    }
  }, [])

  const hasUpdate = !!latest && isNewer(latest.tag, current)
  return {
    current,
    latest: latest?.tag ?? null,
    releaseUrl: latest?.htmlUrl ?? null,
    hasUpdate,
  }
}
