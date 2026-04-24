import { useEffect, useState } from 'react'
import { SectionHeader, SelectBox, SettingRow } from '@/components/settings/SettingsShell'
import { useT, type Locale } from '@/lib/i18n'
import { listModels, type ModelInfo } from '@/lib/api/models'
import { listProviders, type ProviderStatus } from '@/lib/api/providers'
import { useAppStore } from '@/lib/stores/useAppStore'

export function GeneralSection() {
  const t = useT()
  const { locale, setLocale, defaultModel, setDefaultModel } = useAppStore()

  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)

  useEffect(() => {
    void listProviders()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [])

  const currentProviderId = defaultModel?.providerId ?? ''

  useEffect(() => {
    if (!currentProviderId) {
      setModels(null)
      return
    }
    setLoadingModels(true)
    listModels(currentProviderId)
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false))
  }, [currentProviderId])

  const connected = providers?.filter((p) => p.connected) ?? []

  const onProviderChange = (providerId: string) => {
    if (!providerId) {
      setDefaultModel(null)
      return
    }
    // Set provider, default to first model when we load them.
    setDefaultModel({ providerId, model: defaultModel?.providerId === providerId ? defaultModel.model : '' })
  }

  const onModelChange = (model: string) => {
    if (!currentProviderId) return
    setDefaultModel({ providerId: currentProviderId, model })
  }

  return (
    <>
      <SectionHeader
        title={t('settings.general.header')}
        desc={t('settings.general.headerDesc')}
      />

      <SettingRow label={t('settings.general.language')} hint={t('settings.general.languageHint')}>
        <SelectBox
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          <option value="en">English</option>
          <option value="ko">한국어</option>
        </SelectBox>
      </SettingRow>

      <SettingRow
        label={t('settings.general.defaultModel')}
        hint={t('settings.general.defaultModelHint')}
      >
        <div className="flex items-center gap-2">
          <SelectBox
            value={currentProviderId}
            onChange={(e) => onProviderChange(e.target.value)}
            className="min-w-[160px]"
          >
            <option value="">{t('settings.general.providerPlaceholder')}</option>
            {connected.length === 0 && providers && (
              <option disabled>{t('settings.general.noProviders')}</option>
            )}
            {connected.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </SelectBox>
          <SelectBox
            value={defaultModel?.model ?? ''}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={!currentProviderId || loadingModels}
            className="min-w-[200px]"
          >
            <option value="">
              {loadingModels ? '' : t('settings.general.modelPlaceholder')}
            </option>
            {(models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.default ? ` · ${t('settings.general.recommended')}` : ''}
              </option>
            ))}
          </SelectBox>
        </div>
      </SettingRow>
    </>
  )
}
