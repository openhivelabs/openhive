import { Monitor, Moon, Sun } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { SectionHeader, SettingRow } from '@/components/settings/SettingsShell'
import { useT } from '@/lib/i18n'
import { useAppStore, type Theme } from '@/lib/stores/useAppStore'

const THEMES: { id: Theme; icon: typeof Sun }[] = [
  { id: 'light', icon: Sun },
  { id: 'dark', icon: Moon },
  { id: 'system', icon: Monitor },
]

export function AppearanceSection() {
  const t = useT()
  const { theme, setTheme } = useAppStore()
  return (
    <>
      <SectionHeader
        title={t('settings.appearance.header')}
        desc={t('settings.appearance.headerDesc')}
      />
      <SettingRow
        label={t('settings.appearance.theme')}
        hint={t('settings.appearance.themeHint')}
      >
        <div className="flex items-center gap-1 p-1 rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800">
          {THEMES.map(({ id, icon: Icon }) => {
            const active = theme === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTheme(id)}
                className={clsx(
                  'h-7 px-2.5 rounded-sm text-[14px] flex items-center gap-1.5 cursor-pointer',
                  active
                    ? 'bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900'
                    : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {t(`settings.appearance.theme.${id}`)}
              </button>
            )
          })}
        </div>
      </SettingRow>
      <SettingRow
        label={t('settings.appearance.accent')}
        hint={t('settings.appearance.accentHint')}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-5 rounded-sm bg-amber-400 ring-2 ring-amber-300" />
          <span className="text-[14px] text-neutral-500 font-mono">amber-400</span>
        </div>
      </SettingRow>
    </>
  )
}
