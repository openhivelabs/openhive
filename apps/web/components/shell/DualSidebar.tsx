import { Buildings, GearSix, Plus, SidebarSimple } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { CompanySettingsModal } from '@/components/modals/CompanySettingsModal'
import { NewTeamModal } from '@/components/modals/NewTeamModal'
import { TeamSettingsModal } from '@/components/modals/TeamSettingsModal'
import { CompanyRail } from '@/components/shell/CompanyRail'
import { TeamIcon } from '@/components/shell/TeamIcon'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'

/**
 * CompanyRail (52px) + TeamPanel (220px). Used by team routes.
 * Settings route renders only CompanyRail so the company switcher stays visible.
 */
export function DualSidebar() {
  const t = useT()
  const { pathname } = useLocation()
  const routeParams = useParams<{ companySlug?: string; teamSlug?: string }>()
  // Derive the first segment after `/${companySlug}/${teamSlug}/` — equivalent
  // to Next's useSelectedLayoutSegment() inside the team layout.
  let segment: string | null = null
  if (routeParams.companySlug && routeParams.teamSlug) {
    const prefix = `/${routeParams.companySlug}/${routeParams.teamSlug}/`
    if (pathname.startsWith(prefix)) {
      segment = pathname.slice(prefix.length).split('/')[0] || null
    }
  }
  const companies = useAppStore((s) => s.companies)
  const currentCompanyId = useAppStore((s) => s.currentCompanyId)
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const collapsed = useAppStore((s) => s.teamPanelCollapsed)
  const toggleTeamPanel = useAppStore((s) => s.toggleTeamPanel)

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

      <aside
        className={clsx(
          'shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col transition-[width]',
          collapsed ? 'w-[52px]' : 'w-[220px]',
        )}
      >
        {selectedCompany && (collapsed ? (
          /* ── 접힌 상태 : 52px 세로 레일 — 상단은 토글 버튼만 ── */
          <>
            <div className="px-2 pt-3 pb-2 flex flex-col items-center border-b border-neutral-100 dark:border-neutral-800">
              <button
                type="button"
                onClick={toggleTeamPanel}
                aria-label="팀 패널 펼치기"
                title="팀 패널 펼치기"
                className="w-9 h-9 rounded-md flex items-center justify-center text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
              >
                <SidebarSimple className="w-[18px] h-[18px]" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-1.5">
              {selectedCompany.teams.map((team) => {
                const isActive = currentTeamId === team.id
                return (
                  <Link
                    key={team.id}
                    to={`/${selectedCompany.slug}/${team.slug}/${tab}`}
                    title={team.name}
                    className={clsx(
                      'w-9 h-9 rounded-md flex items-center justify-center shrink-0 cursor-pointer',
                      isActive
                        ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 ring-1 ring-amber-200 dark:ring-amber-800/60'
                        : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                    )}
                  >
                    <TeamIcon name={team.icon} className="w-4 h-4" />
                  </Link>
                )
              })}
              <button
                type="button"
                onClick={() => setNewTeamCompanyId(selectedCompany.id)}
                aria-label={t('sidebar.newTeam')}
                title={t('sidebar.newTeam')}
                className="w-9 h-9 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 text-neutral-400 hover:text-neutral-700 hover:border-neutral-500 flex items-center justify-center cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </>
        ) : (
          /* ── 펼친 상태 : 220px 기본 패널 ── */
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
                className="w-7 h-7 flex items-center justify-center rounded-sm text-neutral-500 opacity-0 group-hover:opacity-100 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
              >
                <GearSix className="w-[18px] h-[18px]" />
              </button>
              <button
                type="button"
                aria-label="팀 패널 접기"
                title="팀 패널 접기"
                onClick={toggleTeamPanel}
                className="w-7 h-7 flex items-center justify-center rounded-sm text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
              >
                <SidebarSimple className="w-[18px] h-[18px]" />
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
                        to={`/${selectedCompany.slug}/${team.slug}/${tab}`}
                        className={clsx(
                          'flex-1 flex items-center gap-2 px-2 py-1.5 text-[15px] min-w-0 cursor-pointer',
                          isActive
                            ? 'text-amber-900 dark:text-amber-200'
                            : 'text-neutral-700 dark:text-neutral-200',
                        )}
                      >
                        <TeamIcon
                          name={team.icon}
                          className="w-3.5 h-3.5 text-neutral-400 shrink-0"
                        />
                        <span className="flex-1 truncate">{team.name}</span>
                      </Link>
                      <button
                        type="button"
                        aria-label={t('sidebar.teamSettings')}
                        onClick={() =>
                          setTeamSettings({ companyId: selectedCompany.id, teamId: team.id })
                        }
                        className="mr-1 w-7 h-7 flex items-center justify-center rounded-sm text-neutral-500 opacity-0 group-hover:opacity-100 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
                      >
                        <GearSix className="w-[18px] h-[18px]" />
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
        ))}
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
