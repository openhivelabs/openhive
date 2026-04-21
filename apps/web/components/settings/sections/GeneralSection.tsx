'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, SettingRow } from '@/components/settings/SettingsShell'
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
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          className="h-8 px-2 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[14px] text-neutral-800 dark:text-neutral-100"
        >
          <option value="en">English</option>
          <option value="ko">한국어</option>
        </select>
      </SettingRow>

      <SettingRow
        label="기본 AI 모델"
        hint="새 에이전트를 만들 때 기본값으로 채워지고, 채팅·커스터마이즈에서 초기 선택으로 쓰입니다. 각 화면에서 개별 변경 가능."
      >
        <div className="flex items-center gap-2">
          <select
            value={currentProviderId}
            onChange={(e) => onProviderChange(e.target.value)}
            className="h-8 px-2 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[14px] text-neutral-800 dark:text-neutral-100 min-w-[140px]"
          >
            <option value="">프로바이더 선택…</option>
            {connected.length === 0 && providers && (
              <option disabled>연결된 프로바이더 없음</option>
            )}
            {connected.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            value={defaultModel?.model ?? ''}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={!currentProviderId || loadingModels}
            className="h-8 px-2 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[14px] text-neutral-800 dark:text-neutral-100 min-w-[180px] disabled:opacity-50"
          >
            <option value="">
              {loadingModels ? '불러오는 중…' : '모델 선택…'}
            </option>
            {(models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.default ? ' · 권장' : ''}
              </option>
            ))}
          </select>
        </div>
      </SettingRow>

      <SettingRow
        label={t('settings.general.defaultLanding')}
        hint={t('settings.general.defaultLandingHint')}
      >
        <select
          disabled
          className="h-8 px-2 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[14px] text-neutral-800 dark:text-neutral-100 opacity-60"
        >
          <option>Dashboard</option>
          <option>Chat</option>
        </select>
      </SettingRow>
    </>
  )
}
