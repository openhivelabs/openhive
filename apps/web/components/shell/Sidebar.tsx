'use client'

import { clsx } from 'clsx'
import { Buildings, CaretRight, Plus, Users } from '@phosphor-icons/react'
import { useState } from 'react'
import { NewTeamModal } from '@/components/modals/NewTeamModal'
import { useAppStore } from '@/lib/stores/useAppStore'
import { Button } from '../ui/Button'

export function Sidebar() {
  const { companies, currentCompanyId, currentTeamId, setCompany, setTeam } = useAppStore()
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(companies.map((c) => [c.id, true])),
  )
  const [newTeamCompanyId, setNewTeamCompanyId] = useState<string | null>(null)

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2.5 border-b border-neutral-200 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Organizations
        </span>
        <Button size="sm" variant="ghost" aria-label="Add company">
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {companies.map((company) => (
          <div key={company.id}>
            <button
              type="button"
              onClick={() => {
                setCompany(company.id)
                setExpanded((e) => ({ ...e, [company.id]: !e[company.id] }))
              }}
              className={clsx(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left',
                currentCompanyId === company.id
                  ? 'bg-neutral-100 text-neutral-900'
                  : 'text-neutral-700 hover:bg-neutral-50',
              )}
            >
              <CaretRight
                className={clsx(
                  'w-3.5 h-3.5 transition-transform text-neutral-400',
                  expanded[company.id] && 'rotate-90',
                )}
              />
              <Buildings className="w-4 h-4 text-neutral-500" />
              <span className="flex-1 truncate">{company.name}</span>
            </button>

            {expanded[company.id] && (
              <div className="ml-6 mt-0.5 space-y-0.5">
                {company.teams.map((team) => (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => {
                      setCompany(company.id)
                      setTeam(team.id)
                    }}
                    className={clsx(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left',
                      currentTeamId === team.id
                        ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200'
                        : 'text-neutral-600 hover:bg-neutral-50',
                    )}
                  >
                    <Users className="w-3.5 h-3.5 text-neutral-400" />
                    <span className="flex-1 truncate">{team.name}</span>
                    <span className="text-xs text-neutral-400">{team.agents.length}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setNewTeamCompanyId(company.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-neutral-400 hover:text-neutral-600 hover:bg-neutral-50"
                >
                  <Plus className="w-3 h-3" /> New team
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <NewTeamModal
        open={!!newTeamCompanyId}
        companyId={newTeamCompanyId}
        onClose={() => setNewTeamCompanyId(null)}
      />
    </div>
  )
}
