import { useEffect, useState } from 'react'
import { type PanelCacheRow, fetchPanelData, refreshPanel } from '@/lib/api/panels'

/**
 * Poll a bound panel's cached data every few seconds. Previously we used SSE
 * (EventSource) per panel, but Chrome caps HTTP/1.1 at ~6 connections per
 * origin — with a handful of panels open those slots filled up and blocked
 * new fetches (action writes, composer chat, etc). Polling is plenty for
 * single-user local dashboards and keeps the connection pool free.
 */
const POLL_MS = 10000

export function usePanelData(
  blockId: string,
  active: boolean,
): {
  data: unknown
  error: string | null
  fetchedAt: number | null
  shapeChanged: boolean
  loading: boolean
} {
  const [row, setRow] = useState<PanelCacheRow | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!active || !blockId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // First fetch on mount (page load / hard refresh) actually re-executes the
    // binding instead of reading the cache, so users see fresh data without
    // having to wait for the next poll. Subsequent ticks read the cache (the
    // background scheduler keeps it warm based on each panel's
    // refresh_seconds).
    let firstTick = true

    const tick = async () => {
      try {
        const r = firstTick ? await refreshPanel(blockId) : await fetchPanelData(blockId)
        if (!cancelled) setRow(r)
      } catch {
        /* swallow — next tick retries */
      } finally {
        firstTick = false
        if (!cancelled && loading) setLoading(false)
        if (!cancelled) timer = setTimeout(tick, POLL_MS)
      }
    }

    setLoading(true)
    void tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, active])

  return {
    data: row?.data ?? null,
    error: row?.error ?? null,
    fetchedAt: row?.fetched_at ?? null,
    shapeChanged: !!row?.shape_changed,
    loading,
  }
}
