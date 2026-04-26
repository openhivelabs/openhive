import { useCallback, useEffect, useRef, useState } from 'react'
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
  loading: boolean
  /** Force an immediate server refresh and write the result into local state.
   *  Use this after a panel action (create/update/delete) so the UI updates
   *  without waiting for the next poll tick. */
  refresh: () => Promise<void>
} {
  const [row, setRow] = useState<PanelCacheRow | null>(null)
  const [loading, setLoading] = useState(false)
  // Polling timer + cancellation flag are stored in refs so the manual
  // `refresh` callback can reset the next tick (avoid double-fetches racing).
  const cancelledRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (!blockId) return
    try {
      const r = await refreshPanel(blockId)
      if (!cancelledRef.current) {
        setRow(r)
        // Reset the next poll tick so we don't immediately re-fetch.
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          // The polling effect's tick closure will pick up again on the next
          // schedule — we just need to keep the loop alive.
          void fetchPanelData(blockId).then((next) => {
            if (!cancelledRef.current) setRow(next)
          }).catch(() => {})
        }, POLL_MS)
      }
    } catch {
      /* surfaces on next tick */
    }
  }, [blockId])

  useEffect(() => {
    if (!active || !blockId) return
    cancelledRef.current = false
    // First fetch on mount (page load / hard refresh) actually re-executes the
    // binding instead of reading the cache, so users see fresh data without
    // having to wait for the next poll. Subsequent ticks read the cache (the
    // background scheduler keeps it warm based on each panel's
    // refresh_seconds).
    let firstTick = true

    const tick = async () => {
      try {
        const r = firstTick ? await refreshPanel(blockId) : await fetchPanelData(blockId)
        if (!cancelledRef.current) setRow(r)
      } catch {
        /* swallow — next tick retries */
      } finally {
        firstTick = false
        if (!cancelledRef.current && loading) setLoading(false)
        if (!cancelledRef.current) timerRef.current = setTimeout(tick, POLL_MS)
      }
    }

    setLoading(true)
    void tick()

    return () => {
      cancelledRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, active])

  return {
    data: row?.data ?? null,
    error: row?.error ?? null,
    fetchedAt: row?.fetched_at ?? null,
    loading,
    refresh,
  }
}
