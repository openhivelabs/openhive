import { SectionHeader, SettingRow } from '@/components/settings/SettingsShell'
import { useT } from '@/lib/i18n'

export function DataSection() {
  const t = useT()
  return (
    <>
      <SectionHeader title={t('settings.data.header')} desc={t('settings.data.headerDesc')} />
      <SettingRow label={t('settings.data.location')} hint={t('settings.data.locationHint')}>
        <span className="text-[13px] text-neutral-500 font-mono">~/.openhive</span>
      </SettingRow>
      <SettingRow label={t('settings.data.export')} hint={t('settings.data.exportHint')}>
        <button
          type="button"
          disabled
          className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-[13px] text-neutral-700 dark:text-neutral-200 opacity-60"
          title={t('settings.data.comingSoon')}
        >
          {t('settings.data.exportButton')}
        </button>
      </SettingRow>
      <SettingRow
        label={t('settings.data.cloudBackup')}
        hint={t('settings.data.cloudBackupHint')}
      >
        <button
          type="button"
          disabled
          className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-[13px] text-neutral-700 dark:text-neutral-200 opacity-60"
          title={t('settings.data.comingSoon')}
        >
          {t('settings.data.configure')}
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
        <span className="text-[13px] font-mono text-neutral-500">0.0.1</span>
      </SettingRow>
      <SettingRow label={t('settings.about.license')}>
        <a
          href="https://opensource.org/license/mit"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-mono text-neutral-700 dark:text-neutral-200 hover:underline"
        >
          MIT
        </a>
      </SettingRow>
      <SettingRow label={t('settings.about.source')}>
        <a
          href="https://github.com/openhivelabs/openhive"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-mono text-neutral-700 dark:text-neutral-200 hover:underline"
        >
          github.com/openhivelabs/openhive
        </a>
      </SettingRow>
    </>
  )
}
