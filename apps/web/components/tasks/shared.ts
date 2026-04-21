import { useEffect, useState } from 'react'
import type { Locale } from '@/lib/i18n'
import type { Session } from '@/lib/types'

export const SUPPORTED_PROVIDERS = new Set(['copilot', 'claude-code', 'codex'])

export function makeTaskId() {
  return `t-${Math.random().toString(36).slice(2, 9)}`
}

/** Format a duration as compact human text. 0 → "0s", <60s → "12.3s",
 *  <60m → "2m 14s", else "1h 5m". Negative inputs clamp to 0. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSec = ms / 1000
  if (totalSec < 60) {
    return `${Math.floor(totalSec)}s`
  }
  const minutes = Math.floor(totalSec / 60)
  const seconds = Math.floor(totalSec % 60)
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return `${hours}h ${remMin}m`
}

/** Compute a session's elapsed ms. Uses endedAt if present, else `now`. */
export function runElapsedMs(session: Session, now: number): number {
  const start = Date.parse(session.startedAt)
  if (Number.isNaN(start)) return 0
  const end = session.endedAt ? Date.parse(session.endedAt) : now
  return Math.max(0, end - start)
}

/** Re-render every `intervalMs` while `active` is true. Used to keep the
 *  displayed elapsed time fresh during a running task. Stops the timer when
 *  inactive so finished tasks don't burn cycles. */
export function useTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return now
}

export function fmtRelative(
  iso: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  locale: Locale,
): string {
  try {
    const d = new Date(iso)
    const now = Date.now()
    const diff = now - d.getTime()
    if (diff < 60_000) return t('time.justNow')
    if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) })
    if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3_600_000) })
    return d.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
