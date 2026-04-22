import { CaretDown, Check, Monitor, Moon, Sun } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { SectionHeader, SettingRow } from '@/components/settings/SettingsShell'
import { useT } from '@/lib/i18n'
import { useAppStore, type Accent, type Theme } from '@/lib/stores/useAppStore'

const THEMES: { id: Theme; icon: typeof Sun }[] = [
  { id: 'light', icon: Sun },
  { id: 'dark', icon: Moon },
  { id: 'system', icon: Monitor },
]

const ACCENT_SWATCHES: { id: Accent; color: string }[] = [
  { id: 'amber', color: '#f59e0b' },
  { id: 'red', color: '#ef4444' },
  { id: 'pink', color: '#ec4899' },
  { id: 'violet', color: '#8b5cf6' },
  { id: 'blue', color: '#3b82f6' },
  { id: 'lime', color: '#84cc16' },
  { id: 'brown', color: '#8b5a2b' },
  { id: 'graphite', color: '#374151' },
]

export function AppearanceSection() {
  const t = useT()
  const { theme, setTheme, accent, setAccent } = useAppStore()
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
        <div className="inline-flex items-center gap-1 p-1 rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800">
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
        <AccentPicker value={accent} onChange={setAccent} />
      </SettingRow>
    </>
  )
}

function AccentPicker({ value, onChange }: { value: Accent; onChange: (a: Accent) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = ACCENT_SWATCHES.find((s) => s.id === value) ?? ACCENT_SWATCHES[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 pl-1.5 pr-2 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 flex items-center gap-2 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
      >
        <span
          className="w-5 h-5 rounded-sm ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700"
          style={{ backgroundColor: current.color }}
        />
        <span className="text-[13px] text-neutral-700 dark:text-neutral-200 capitalize">{current.id}</span>
        <CaretDown weight="bold" className="w-3 h-3 text-neutral-500" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-20 min-w-[140px] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg py-1">
          {ACCENT_SWATCHES.map(({ id, color }) => {
            const active = value === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  onChange(id)
                  setOpen(false)
                }}
                className={clsx(
                  'w-full flex items-center gap-2 px-2 py-1.5 text-left cursor-pointer',
                  active
                    ? 'bg-neutral-100 dark:bg-neutral-700/60'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-700/40',
                )}
              >
                <span
                  className="w-4 h-4 rounded-sm shrink-0 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700"
                  style={{ backgroundColor: color }}
                />
                <span className="text-[13px] text-neutral-700 dark:text-neutral-200 capitalize flex-1">
                  {id}
                </span>
                {active && <Check weight="bold" className="w-3.5 h-3.5 text-neutral-500" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
