import { Archive, ChartBar, ListBullets, Network } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { Link, useLocation } from 'react-router-dom'
import { useT } from '@/lib/i18n'

const TABS = [
  { id: 'dashboard', icon: ChartBar },
  { id: 'tasks', icon: ListBullets },
  { id: 'team', icon: Network },
  { id: 'records', icon: Archive },
] as const

interface TeamTabsProps {
  companySlug: string
  teamSlug: string
}

// Some routes live outside the tab path shape (session page at `/s/{id}`,
// preview pages, etc.) but conceptually belong to one of the tabs. Map the raw
// first segment to the tab id it should light up.
const SEGMENT_TO_TAB: Record<string, (typeof TABS)[number]['id']> = {
  dashboard: 'dashboard',
  tasks: 'tasks',
  s: 'tasks',
  team: 'team',
  records: 'records',
}

export function TeamTabs({ companySlug, teamSlug }: TeamTabsProps) {
  const t = useT()
  const { pathname } = useLocation()
  // Extract the first path segment AFTER `/${companySlug}/${teamSlug}/`.
  // Previously `useSelectedLayoutSegment()` from Next gave us this value.
  const prefix = `/${companySlug}/${teamSlug}/`
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
  const raw = rest.split('/')[0] || 'dashboard'
  const segment = SEGMENT_TO_TAB[raw] ?? raw
  return (
    <nav className="h-[42px] shrink-0 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 flex items-center justify-center gap-1">
      {TABS.map(({ id, icon: Icon }) => {
        const active = segment === id
        const label = t(`tab.${id}`)
        return (
          <Link
            key={id}
            to={`/${companySlug}/${teamSlug}/${id}`}
            title={label}
            aria-label={label}
            className={clsx(
              'flex items-center gap-1.5 h-[32px] rounded-sm text-[14px] cursor-pointer',
              active
                ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 px-3'
                : 'w-9 justify-center text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800',
            )}
          >
            <Icon className="w-4 h-4" />
            {active && <span>{label}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
