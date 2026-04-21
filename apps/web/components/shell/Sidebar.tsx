'use client'

import { Buildings, CaretRight, GearSix, Plus, Users } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useState } from 'react'
import { CompanySettingsModal } from '@/components/modals/CompanySettingsModal'
import { NewTeamModal } from '@/components/modals/NewTeamModal'
import { SettingsModal } from '@/components/modals/SettingsModal'
import { TeamSettingsModal } from '@/components/modals/TeamSettingsModal'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import { Button } from '../ui/Button'

export function Sidebar() {
  const t = useT()
  const companies = useAppStore((s) => s.companies)
  const currentCompanyId = useAppStore((s) => s.currentCompanyId)
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const setCompany = useAppStore((s) => s.setCompany)
  const setTeam = useAppStore((s) => s.setTeam)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(companies.map((c) => [c.id, true])),
  )
  const [newTeamCompanyId, setNewTeamCompanyId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [teamSettings, setTeamSettings] = useState<{ companyId: string; teamId: string } | null>(
    null,
  )
  const [companySettingsId, setCompanySettingsId] = useState<string | null>(null)

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 pt-3 pb-2">
        <span className="text-[14px] font-semibold uppercase tracking-wider text-neutral-400">
          {t('sidebar.workspace')}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-3">
        {companies.map((company) => {
          const isExpanded = expanded[company.id] ?? true
          const isCompanyActive = currentCompanyId === company.id
          return (
            <div key={company.id} className="space-y-0.5">
              <div
                className={clsx(
                  'group flex items-center gap-1 rounded-sm',
                  isCompanyActive ? 'bg-neutral-100' : 'hover:bg-neutral-50',
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpanded((e) => ({ ...e, [company.id]: !isExpanded }))}
                  className="w-6 h-6 flex items-center justify-center shrink-0 text-neutral-400 cursor-pointer"
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  <CaretRight
                    className={clsx(
                      'w-3 h-3 transition-transform',
                      isExpanded && 'rotate-90',
                    )}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => setCompany(company.id)}
                  className="flex-1 flex items-center gap-2 py-1.5 text-[15px] text-neutral-800 text-left min-w-0 cursor-pointer"
                >
                  <Buildings className="w-4 h-4 text-neutral-500 shrink-0" />
                  <span className="truncate font-medium">{company.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={t('sidebar.companySettings')}
                  onClick={() => setCompanySettingsId(company.id)}
                  className="w-6 h-6 flex items-center justify-center text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-700 cursor-pointer"
                >
                  <GearSix className="w-3.5 h-3.5" />
                </button>
              </div>

              {isExpanded && (
                <div className="ml-5 pl-2 border-l border-neutral-200 space-y-0.5">
                  {company.teams.map((team) => {
                    const isActive = currentTeamId === team.id
                    return (
                      <div
                        key={team.id}
                        className={clsx(
                          'group flex items-center gap-1 rounded-sm',
                          isActive
                            ? 'bg-amber-50 ring-1 ring-amber-200'
                            : 'hover:bg-neutral-50',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setCompany(company.id)
                            setTeam(team.id)
                          }}
                          className={clsx(
                            'flex-1 flex items-center gap-2 px-2 py-1.5 text-[15px] text-left min-w-0 cursor-pointer',
                            isActive ? 'text-amber-900' : 'text-neutral-600',
                          )}
                        >
                          <Users className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                          <span className="flex-1 truncate">{team.name}</span>
                          <span className="text-[14px] text-neutral-400 font-mono">
                            {team.agents.length}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={t('sidebar.teamSettings')}
                          onClick={() => setTeamSettings({ companyId: company.id, teamId: team.id })}
                          className="w-6 h-6 flex items-center justify-center text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-700 cursor-pointer"
                        >
                          <GearSix className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setNewTeamCompanyId(company.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-[15px] text-neutral-400 hover:text-neutral-700 hover:bg-neutral-50 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" /> {t('sidebar.newTeam')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="border-t border-neutral-200 p-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-[15px] text-neutral-600 hover:bg-neutral-50 cursor-pointer"
        >
          <GearSix className="w-4 h-4 text-neutral-500" />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>

      <NewTeamModal
        open={!!newTeamCompanyId}
        companyId={newTeamCompanyId}
        onClose={() => setNewTeamCompanyId(null)}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
    </div>
  )
}
