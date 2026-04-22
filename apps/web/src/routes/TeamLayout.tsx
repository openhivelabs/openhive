import { DualSidebar } from '@/components/shell/DualSidebar'
import { TeamTabs } from '@/components/shell/TeamTabs'
import { hydrateLocaleFromStorage, useAppStore } from '@/lib/stores/useAppStore'
import { useTasksStore } from '@/lib/stores/useTasksStore'
import { useEffect } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router-dom'

export function TeamLayout() {
  const params = useParams<{ companySlug: string; teamSlug: string }>()
  const companySlug = params?.companySlug
  const teamSlug = params?.teamSlug
  const navigate = useNavigate()
  const { companies, currentCompanyId, currentTeamId, hydrated, hydrate, setCompany, setTeam } =
    useAppStore()
  const hydrateTasks = useTasksStore((s) => s.hydrate)

  useEffect(() => {
    hydrateLocaleFromStorage()
    void hydrate()
    void hydrateTasks()
  }, [hydrate, hydrateTasks])

  useEffect(() => {
    if (!hydrated || !companySlug || !teamSlug) return
    const company = companies.find((c) => c.slug === companySlug)
    const team = company?.teams.find((t) => t.slug === teamSlug)
    if (!company || !team) {
      const fallbackCompany = companies[0]
      const fallbackTeam = fallbackCompany?.teams[0]
      if (fallbackCompany && fallbackTeam) {
        navigate(`/${fallbackCompany.slug}/${fallbackTeam.slug}/dashboard`, {
          replace: true,
        })
      }
      return
    }
    if (currentCompanyId !== company.id) setCompany(company.id)
    if (currentTeamId !== team.id) setTeam(team.id)
  }, [
    hydrated,
    companySlug,
    teamSlug,
    companies,
    currentCompanyId,
    currentTeamId,
    navigate,
    setCompany,
    setTeam,
  ])

  return (
    <div className="h-screen flex bg-neutral-50 dark:bg-neutral-950">
      <DualSidebar />
      <div className="flex-1 flex flex-col min-w-0 bg-neutral-50 dark:bg-neutral-950">
        {companySlug && teamSlug && <TeamTabs companySlug={companySlug} teamSlug={teamSlug} />}
        <main className="flex-1 overflow-hidden min-h-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
