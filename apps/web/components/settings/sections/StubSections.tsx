import { SectionHeader, SettingRow } from '@/components/settings/SettingsShell'
import { useT } from '@/lib/i18n'
import { useState } from 'react'

export function DataSection() {
  const t = useT()
  const [preparing, setPreparing] = useState(false)

  const onDownload = () => {
    if (preparing) return
    setPreparing(true)
    // Navigate to the streaming endpoint; browser handles the download via
    // Content-Disposition. Reset the button after a short delay so the user
    // can trigger another backup without reloading.
    window.location.href = '/api/backup/download'
    window.setTimeout(() => setPreparing(false), 4000)
  }

  return (
    <>
      <SectionHeader title={t('settings.data.header')} desc={t('settings.data.headerDesc')} />
      <SettingRow label={t('settings.data.location')} hint={t('settings.data.locationHint')}>
        <span className="text-[13px] text-neutral-500 font-mono">~/.openhive</span>
      </SettingRow>
      <SettingRow label={t('settings.data.export')} hint={t('settings.data.exportHint')}>
        <button
          type="button"
          onClick={onDownload}
          disabled={preparing}
          className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-[13px] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-60 disabled:cursor-wait"
        >
          {preparing ? t('settings.data.exportPreparing') : t('settings.data.exportButton')}
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
        <span className="text-[13px] font-mono text-neutral-500">{__APP_VERSION__}</span>
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
