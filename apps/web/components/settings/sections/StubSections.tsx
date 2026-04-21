'use client'

import { SectionHeader, SettingRow } from '@/components/settings/SettingsShell'
import { useT } from '@/lib/i18n'

export function AccountSection() {
  const t = useT()
  return (
    <>
      <SectionHeader
        title={t('settings.account.header')}
        desc={t('settings.account.headerDesc')}
      />
      <SettingRow label={t('settings.account.mode')} hint={t('settings.account.modeHint')}>
        <span className="text-[14px] text-neutral-500 font-mono">local · single-user</span>
      </SettingRow>
      <SettingRow label={t('settings.account.bind')} hint={t('settings.account.bindHint')}>
        <span className="text-[14px] text-neutral-500 font-mono">127.0.0.1:4484</span>
      </SettingRow>
    </>
  )
}

export function DataSection() {
  const t = useT()
  return (
    <>
      <SectionHeader title={t('settings.data.header')} desc={t('settings.data.headerDesc')} />
      <SettingRow label={t('settings.data.location')} hint={t('settings.data.locationHint')}>
        <span className="text-[14px] text-neutral-500 font-mono">~/.openhive</span>
      </SettingRow>
      <SettingRow
        label="ZIP 내보내기"
        hint="단일 팀 또는 전체 워크스페이스를 하나의 zip 파일로 내보냅니다. 다른 머신으로 이식 가능. (추후 구현)"
      >
        <button
          type="button"
          disabled
          className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-[14px] text-neutral-700 dark:text-neutral-200 opacity-60"
        >
          Export zip
        </button>
      </SettingRow>
      <SettingRow
        label="주기적 클라우드 백업"
        hint="S3 · Google Drive · Dropbox 등에 설정한 주기로 자동 백업. (추후 구현)"
      >
        <button
          type="button"
          disabled
          className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-[14px] text-neutral-700 dark:text-neutral-200 opacity-60"
        >
          설정…
        </button>
      </SettingRow>
    </>
  )
}

export function AboutSection() {
  const t = useT()
  return (
    <>
      <SectionHeader title={t('settings.about.header')} desc={t('settings.about.headerDesc')} />
      <SettingRow label={t('settings.about.version')}>
        <span className="text-[14px] font-mono text-neutral-600 dark:text-neutral-300">0.0.1</span>
      </SettingRow>
      <SettingRow label={t('settings.about.license')}>
        <span className="text-[14px] font-mono text-neutral-600 dark:text-neutral-300">
          AGPL-3.0
        </span>
      </SettingRow>
      <SettingRow label={t('settings.about.source')}>
        <a
          href="https://github.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[14px] text-amber-600 hover:underline"
        >
          github.com/openhive
        </a>
      </SettingRow>
    </>
  )
}
