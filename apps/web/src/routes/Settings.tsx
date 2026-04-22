import { type SettingsSection, SettingsShell } from '@/components/settings/SettingsShell'
import { AppearanceSection } from '@/components/settings/sections/AppearanceSection'
import { CredentialsSection } from '@/components/settings/sections/CredentialsSection'
import { GeneralSection } from '@/components/settings/sections/GeneralSection'
import { McpSection } from '@/components/settings/sections/McpSection'
import { ProvidersSection } from '@/components/settings/sections/ProvidersSection'
import { AboutSection, DataSection } from '@/components/settings/sections/StubSections'
import { UsageSection } from '@/components/settings/sections/UsageSection'
import { CompanyRail } from '@/components/shell/CompanyRail'
import { hydrateLocaleFromStorage, useAppStore } from '@/lib/stores/useAppStore'
import { useEffect, useState } from 'react'

const SECTION_COMPONENTS: Record<SettingsSection, () => React.ReactElement> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  providers: ProvidersSection,
  credentials: CredentialsSection,
  mcp: McpSection,
  usage: UsageSection,
  data: DataSection,
  about: AboutSection,
}

export function Settings() {
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
