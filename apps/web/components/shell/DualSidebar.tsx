'use client'

import { Buildings, GearSix, Plus, Users } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'
import { useState } from 'react'
import { CompanySettingsModal } from '@/components/modals/CompanySettingsModal'
import { NewTeamModal } from '@/components/modals/NewTeamModal'
import { TeamSettingsModal } from '@/components/modals/TeamSettingsModal'
import { CompanyRail } from '@/components/shell/CompanyRail'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'

/**
 * CompanyRail (52px) + TeamPanel (220px). Used by team routes.
 * Settings route renders only CompanyRail so the company switcher stays visible.
 */
export function DualSidebar() {
  const t = useT()
  const segment = useSelectedLayoutSegment()
  const companies = useAppStore((s) => s.companies)
  const currentCompanyId = useAppStore((s) => s.currentCompanyId)
  const currentTeamId = useAppStore((s) => s.currentTeamId)

  const [newTeamCompanyId, setNewTeamCompanyId] = useState<string | null>(null)
  const [teamSettings, setTeamSettings] = useState<{ companyId: string; teamId: string } | null>(
    null,
  )
  const [companySettingsId, setCompanySettingsId] = useState<string | null>(null)

  const selectedCompany = companies.find((c) => c.id === currentCompanyId) ?? companies[0]
  // Valid top-level tabs. Anything else (e.g. `s` from /{company}/{team}/s/{sessionId})
  // isn't a landing route for a team switch — map those back to a sensible parent
  // so "click team" doesn't route to a dead URL.
  const TOP_TABS = new Set(['dashboard', 'tasks', 'team', 'records'])
  const tab = segment === 's' ? 'tasks' : TOP_TABS.has(segment ?? '') ? (segment as string) : 'dashboard'

  return (
    <>
      <CompanyRail />

      <aside className="w-[220px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col">
        {selectedCompany && (
          <>
            <div className="px-3 pt-3 pb-2 flex items-center gap-2 border-b border-neutral-100 dark:border-neutral-800 group">
              <Buildings className="w-4 h-4 text-neutral-500 shrink-0" />
              <span className="flex-1 truncate text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
                {selectedCompany.name}
              </span>
              <button
                type="button"
                aria-label={t('sidebar.companySettings')}
                onClick={() => setCompanySettingsId(selectedCompany.id)}
                className="w-6 h-6 flex items-center justify-center text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-700 cursor-pointer"
              >
                <GearSix className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-2">
              <div className="px-3 pb-1 text-[14px] font-semibold uppercase tracking-wider text-neutral-400">
                {t('sidebar.teams') ?? 'Teams'}
              </div>
              <div className="px-1 space-y-0.5">
                {selectedCompany.teams.map((team) => {
                  const isActive = currentTeamId === team.id
                  return (
                    <div
                      key={team.id}
                      className={clsx(
                        'group flex items-center gap-1 rounded-sm',
                        isActive
                          ? 'bg-amber-50 dark:bg-amber-950/40 ring-1 ring-amber-200 dark:ring-amber-800/60'
                          : 'hover:bg-neutral-50 dark:hover:bg-neutral-800',
                      )}
                    >
                      <Link
                        href={`/${selectedCompany.slug}/${team.slug}/${tab}`}
                        className={clsx(
                          'flex-1 flex items-center gap-2 px-2 py-1.5 text-[15px] min-w-0 cursor-pointer',
                          isActive
                            ? 'text-amber-900 dark:text-amber-200'
                            : 'text-neutral-700 dark:text-neutral-200',
                        )}
                      >
                        <Users className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span className="flex-1 truncate">{team.name}</span>
                      </Link>
                      <button
                        type="button"
                        aria-label={t('sidebar.teamSettings')}
                        onClick={() =>
                          setTeamSettings({ companyId: selectedCompany.id, teamId: team.id })
                        }
                        className="w-6 h-6 flex items-center justify-center text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-700 cursor-pointer"
                      >
                        <GearSix className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
              <button
                type="button"
                onClick={() => setNewTeamCompanyId(selectedCompany.id)}
                className="mx-1 mt-2 w-[calc(100%-8px)] flex items-center gap-2 px-2 py-1.5 rounded-sm text-[15px] text-neutral-400 hover:text-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
              >
                <Plus className="w-3 h-3" /> {t('sidebar.newTeam')}
              </button>
            </div>
          </>
        )}
      </aside>

      <NewTeamModal
        open={!!newTeamCompanyId}
        companyId={newTeamCompanyId}
        onClose={() => setNewTeamCompanyId(null)}
      />
      <TeamSettingsModal
        open={!!teamSettings}
        companyId={teamSettings?.companyId ?? null}
        teamId={teamSettings?.teamId ?? null}
        onClose={() => setTeamSettings(null)}
      />
      <CompanySettingsModal
        open={!!companySettingsId}
        companyId={companySettingsId}
        onClose={() => setCompanySettingsId(null)}
      />
    </>
  )
}
