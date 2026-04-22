import { GearSix, Plus } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { Link, useNavigate } from 'react-router-dom'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'

/**
 * 52px vertical rail. Always visible across team/settings/other top-level routes.
 * Clicking a company icon jumps to that company's first team dashboard.
 */
export function CompanyRail() {
  const t = useT()
  const navigate = useNavigate()
  const companies = useAppStore((s) => s.companies)
  const currentCompanyId = useAppStore((s) => s.currentCompanyId)
  const setCompany = useAppStore((s) => s.setCompany)
  const selectedId = currentCompanyId || companies[0]?.id

  return (
    <aside className="w-[52px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 flex flex-col">
      <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-1.5">
        {companies.map((company) => {
          const active = selectedId === company.id
          return (
            <button
              key={company.id}
              type="button"
              title={company.name}
              onClick={() => {
                setCompany(company.id)
                const firstTeam = company.teams[0]
                if (firstTeam) navigate(`/${company.slug}/${firstTeam.slug}/dashboard`)
              }}
              className={clsx(
                'w-9 h-9 rounded-md flex items-center justify-center text-[14px] font-semibold cursor-pointer shrink-0',
                active
                  ? 'bg-amber-500 text-white shadow-sm'
                  : 'bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-200 hover:border-neutral-300',
              )}
            >
              {company.name.slice(0, 1).toUpperCase()}
            </button>
          )
        })}
        <button
          type="button"
          aria-label={t('sidebar.addCompany')}
          onClick={() => navigate('/onboarding')}
          className="w-9 h-9 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 text-neutral-400 hover:text-neutral-700 hover:border-neutral-500 flex items-center justify-center cursor-pointer"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      <Link
        to="/settings"
        aria-label={t('sidebar.settings')}
        title={t('sidebar.settings')}
        className="mx-auto mb-2 w-9 h-9 rounded-md flex items-center justify-center text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200/60 dark:hover:bg-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        <GearSix className="w-5 h-5" />
      </Link>
    </aside>
  )
}
