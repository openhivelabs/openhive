import { hydrateLocaleFromStorage, useAppStore } from '@/lib/stores/useAppStore'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export function Home() {
  const navigate = useNavigate()
  const { companies, currentCompanyId, currentTeamId, hydrate, hydrated } = useAppStore()

  useEffect(() => {
    hydrateLocaleFromStorage()
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    if (!hydrated) return
    if (companies.length === 0) {
      navigate('/onboarding', { replace: true })
      return
    }
    const company = companies.find((c) => c.id === currentCompanyId) ?? companies[0]
    const team = company?.teams.find((t) => t.id === currentTeamId) ?? company?.teams[0]
    if (company && team) {
      navigate(`/${company.slug}/${team.slug}/dashboard`, { replace: true })
    }
  }, [hydrated, currentCompanyId, currentTeamId, companies, navigate])

  return null
}
