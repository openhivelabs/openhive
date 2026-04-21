'use client'

import { useEffect, useState } from 'react'
import {
  SettingsShell,
  type SettingsSection,
} from '@/components/settings/SettingsShell'
import { AppearanceSection } from '@/components/settings/sections/AppearanceSection'
import { GeneralSection } from '@/components/settings/sections/GeneralSection'
import { McpSection } from '@/components/settings/sections/McpSection'
import { ProvidersSection } from '@/components/settings/sections/ProvidersSection'
import { UsageSection } from '@/components/settings/sections/UsageSection'
import {
  AboutSection,
  AccountSection,
  DataSection,
} from '@/components/settings/sections/StubSections'
import { CompanyRail } from '@/components/shell/CompanyRail'
import { hydrateLocaleFromStorage, useAppStore } from '@/lib/stores/useAppStore'

const SECTION_COMPONENTS: Record<SettingsSection, () => JSX.Element> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  providers: ProvidersSection,
  mcp: McpSection,
  usage: UsageSection,
  account: AccountSection,
  data: DataSection,
  about: AboutSection,
}

export default function SettingsPage() {
  const hydrate = useAppStore((s) => s.hydrate)
  const [active, setActive] = useState<SettingsSection>('general')

  useEffect(() => {
    hydrateLocaleFromStorage()
    void hydrate()
  }, [hydrate])

  const ActiveSection = SECTION_COMPONENTS[active]

  return (
    <div className="h-screen flex bg-neutral-50 dark:bg-neutral-950">
      <CompanyRail />
      <div className="flex-1 min-h-0">
        <SettingsShell active={active} onSelect={setActive}>
          <ActiveSection />
        </SettingsShell>
      </div>
    </div>
  )
}
