import { useEffect, useState } from 'react'
import { type PanelCacheRow, fetchPanelData } from '@/lib/api/panels'

/**
 * Poll a bound panel's cached data every few seconds. Previously we used SSE
 * (EventSource) per panel, but Chrome caps HTTP/1.1 at ~6 connections per
 * origin — with a handful of panels open those slots filled up and blocked
 * new fetches (action writes, composer chat, etc). Polling is plenty for
 * single-user local dashboards and keeps the connection pool free.
 */
const POLL_MS = 3000

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

    const tick = async () => {
      try {
        const r = await fetchPanelData(blockId)
        if (!cancelled) setRow(r)
      } catch {
        /* swallow — next tick retries */
      } finally {
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
