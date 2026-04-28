import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useT } from '@/lib/i18n'
import { useSessionsStore } from '@/lib/stores/useSessionsStore'
import type { Session } from '@/lib/types'

type Tab = 'all' | 'needs_input' | 'running' | 'done' | 'failed'

type Bucket = 'needs_input' | 'unreviewed' | 'running' | 'failed' | 'hidden'

function bucketOf(s: Session): Bucket {
  if (s.status === 'needs_input') return 'needs_input'
  if (s.status === 'failed') return 'failed'
  if (s.status === 'running') return 'running'
  if (s.status === 'done') return s.viewedAt ? 'hidden' : 'unreviewed'
  return 'hidden'
}

const ORDER: Record<Exclude<Bucket, 'hidden'>, number> = {
  needs_input: 0,
  unreviewed: 1,
  running: 2,
  failed: 3,
}

const DOT: Record<Exclude<Bucket, 'hidden'>, string> = {
  needs_input: 'bg-amber-500',
  unreviewed: 'bg-emerald-500',
  running: 'bg-blue-500 animate-pulse',
  failed: 'bg-rose-500',
}

/** Session list grouped by state. No data binding — reads directly
 *  from `useSessionsStore`. Tabs filter by status. */
export function SessionStatusView({ teamId }: { teamId?: string }) {
  const t = useT()
  const navigate = useNavigate()
  const params = useParams<{ companySlug: string; teamSlug: string }>()
  const sessions = useSessionsStore((s) => s.sessions)
  const hydrate = useSessionsStore((s) => s.hydrateForTeam)
  const [tab, setTab] = useState<Tab>('all')

  useEffect(() => {
    if (!teamId) return
    void hydrate(teamId)
  }, [teamId, hydrate])

  const visible = useMemo(() => {
    return sessions
      .filter((s) => !teamId || s.teamId === teamId)
      .map((s) => ({ s, b: bucketOf(s) }))
      .filter((x): x is { s: Session; b: Exclude<Bucket, 'hidden'> } =>
        x.b !== 'hidden',
      )
      .sort((a, b) => {
        const d = ORDER[a.b] - ORDER[b.b]
        if (d !== 0) return d
        return (b.s.startedAt ?? '').localeCompare(a.s.startedAt ?? '')
      })
  }, [sessions, teamId])

  const filtered = useMemo(() => {
    if (tab === 'all') return visible
    const want: Exclude<Bucket, 'hidden'> = tab === 'done' ? 'unreviewed' : tab
    return visible.filter((x) => x.b === want)
  }, [visible, tab])

  const TABS: { key: Tab; label: string }[] = [
    { key: 'all', label: t('sessionStatus.tab.all') },
    { key: 'needs_input', label: t('sessionStatus.tab.needsAnswer') },
    { key: 'running', label: t('sessionStatus.tab.running') },
    { key: 'done', label: t('sessionStatus.tab.done') },
    { key: 'failed', label: t('sessionStatus.tab.failed') },
  ]

  return (
    <div className="h-full w-full flex flex-col">
      <div className="shrink-0 flex items-center gap-4 px-4 pt-2 pb-1.5 text-[12.5px] border-b border-neutral-100 dark:border-neutral-800">
        {TABS.map((tt) => (
          <button
            key={tt.key}
            type="button"
            onClick={() => setTab(tt.key)}
            className={
              tab === tt.key
                ? 'text-neutral-900 dark:text-neutral-100 font-medium cursor-pointer'
                : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 cursor-pointer'
            }
          >
            {tt.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[12.5px] text-neutral-400">
            {t('sessionStatus.empty')}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {filtered.map(({ s, b }) => {
              const title = (s.title ?? '').trim() || s.goal || s.id
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!params.companySlug || !params.teamSlug) return
                      navigate(
                        `/${params.companySlug}/${params.teamSlug}/s/${s.id}`,
                      )
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left text-[13px] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 cursor-pointer"
                  >
                    <span
                      className={`shrink-0 w-2.5 h-2.5 rounded-full ${DOT[b]}`}
                    />
                    <span className="flex-1 min-w-0 truncate">{title}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
