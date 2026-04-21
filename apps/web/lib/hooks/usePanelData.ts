'use client'

import { useEffect, useRef, useState } from 'react'
import { type PanelCacheRow, fetchPanelData, streamPanel } from '@/lib/api/panels'

/**
 * Subscribe to a bound block's live data via SSE, with an initial fetch to
 * populate immediately. Falls back to null until the first event arrives.
 *
 * Usage:
 *   const { data, error, fetchedAt, loading } = usePanelData(block.id, !!block.binding)
 */
export function usePanelData(blockId: string, active: boolean): {
  data: unknown
  error: string | null
  fetchedAt: number | null
  loading: boolean
} {
  const [row, setRow] = useState<PanelCacheRow | null>(null)
  const [loading, setLoading] = useState(false)
  // EventSource instance is kept in ref so re-renders don't reopen the stream.
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!active || !blockId) return
    let cancelled = false
    setLoading(true)
    fetchPanelData(blockId)
      .then((r) => !cancelled && setRow(r))
      .catch(() => {
        /* first-fetch failures are fine — stream will fill in */
      })
      .finally(() => !cancelled && setLoading(false))

    cleanupRef.current = streamPanel(blockId, (r) => setRow(r))

    return () => {
      cancelled = true
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [blockId, active])

  return {
    data: row?.data ?? null,
    error: row?.error ?? null,
    fetchedAt: row?.fetched_at ?? null,
    loading,
  }
}
