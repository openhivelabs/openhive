import { useEffect, useState } from 'react'
import { ArrowCounterClockwise, X } from '@phosphor-icons/react'
import {
  type DashboardBackup,
  fetchDashboardBackups,
  restoreDashboardBackup,
} from '@/lib/api/dashboards'
import { useT } from '@/lib/i18n'

export function HistoryModal({
  teamId,
  onClose,
  onRestored,
}: {
  teamId: string
  onClose: () => void
  onRestored: () => void
}) {
  const t = useT()
  const [backups, setBackups] = useState<DashboardBackup[] | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDashboardBackups(teamId)
      .then((b) => !cancelled && setBackups(b))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [teamId])

  const restore = async (name: string) => {
    if (!window.confirm(t('history.confirmRestore'))) return
    setRestoring(name)
    setError(null)
    try {
      await restoreDashboardBackup(teamId, name)
      onRestored()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[520px] max-w-[90vw] max-h-[70vh] bg-white dark:bg-neutral-900 rounded-lg shadow-xl border border-neutral-200 dark:border-neutral-800 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-800 flex items-center gap-2">
          <ArrowCounterClockwise className="w-4 h-4 text-neutral-500" />
          <span className="flex-1 text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
            {t('history.title')}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-7 h-7 flex items-center justify-center rounded-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {backups === null && (
            <div className="p-4 text-[13px] text-neutral-400">Loading…</div>
          )}
          {backups && backups.length === 0 && (
            <div className="p-4 text-[13px] text-neutral-400">{t('history.empty')}</div>
          )}
          {backups?.map((b) => (
            <div
              key={b.name}
              className="flex items-center gap-2 px-2 py-2 rounded-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-neutral-800 dark:text-neutral-100">
                  {new Date(b.saved_at).toLocaleString()}
                </div>
                <div className="text-[11px] text-neutral-400 font-mono truncate">
                  {b.name}
                </div>
              </div>
              <button
                type="button"
                disabled={restoring === b.name}
                onClick={() => restore(b.name)}
                className="px-2 py-1 rounded-sm text-[12px] text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 cursor-pointer"
              >
                {restoring === b.name ? t('common.submitting') : t('history.restore')}
              </button>
            </div>
          ))}
          {error && (
            <div className="p-3 text-[12px] text-red-600 dark:text-red-400">{error}</div>
          )}
        </div>
      </div>
    </div>
  )
}
