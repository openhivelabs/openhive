'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { hydrateLocaleFromStorage, useAppStore } from '@/lib/stores/useAppStore'

export default function Home() {
  const router = useRouter()
  const { companies, currentCompanyId, currentTeamId, hydrate, hydrated } = useAppStore()

  useEffect(() => {
    hydrateLocaleFromStorage()
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    if (!hydrated) return
    // Empty workspace → onboarding. First-run users land here, and onboarding
    // blocks until at least one AI provider is connected.
    if (companies.length === 0) {
      router.replace('/onboarding')
      return
    }
    const company =
      companies.find((c) => c.id === currentCompanyId) ?? companies[0]
    const team =
      company?.teams.find((t) => t.id === currentTeamId) ?? company?.teams[0]
    if (company && team) {
      router.replace(`/${company.slug}/${team.slug}/dashboard`)
    }
  }, [hydrated, currentCompanyId, currentTeamId, companies, router])

  return (
    <div className="h-screen flex items-center justify-center text-[15px] text-neutral-400">
      Loading…
    </div>
  )
}
