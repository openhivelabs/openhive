import {
  CaretDown,
  ChartBar,
  Database,
  Info,
  Key,
  Palette,
  Plugs,
  PuzzlePiece,
  Sliders,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type { ComponentType, ReactNode, SelectHTMLAttributes } from 'react'
import { useT } from '@/lib/i18n'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'providers'
  | 'credentials'
  | 'mcp'
  | 'usage'
  | 'data'
  | 'about'

const SETTINGS_SECTIONS: {
  id: SettingsSection
  icon: ComponentType<{ className?: string }>
}[] = [
  { id: 'general', icon: Sliders },
  { id: 'appearance', icon: Palette },
  { id: 'providers', icon: Plugs },
  { id: 'credentials', icon: Key },
  { id: 'mcp', icon: PuzzlePiece },
  { id: 'usage', icon: ChartBar },
  { id: 'data', icon: Database },
  { id: 'about', icon: Info },
]

export function SettingsShell({
  active,
  onSelect,
  children,
}: {
  active: SettingsSection
  onSelect: (id: SettingsSection) => void
  children: ReactNode
}) {
  const t = useT()
  return (
    <div className="h-full flex">
      <aside className="w-[240px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col">
        <div className="h-[46px] shrink-0 px-4 flex items-center border-b border-neutral-200 dark:border-neutral-800">
          <span className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
            {t('settings.title')}
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {SETTINGS_SECTIONS.map(({ id, icon: Icon }) => {
            const isActive = active === id
            const label = t(`settings.section.${id}`)
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(id)}
                className={clsx(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm text-left cursor-pointer',
                  isActive
                    ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'
                    : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50',
                )}
              >
                <Icon className="w-4 h-4 text-neutral-500 shrink-0" />
                <span className="text-[14px] font-medium truncate">{label}</span>
              </button>
            )
          })}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="max-w-[1040px] mx-auto p-8">{children}</div>
      </main>
    </div>
  )
}

export function SectionHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <header className="mb-6 pb-4 border-b border-neutral-200 dark:border-neutral-800">
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{title}</h1>
      {desc && <p className="text-[14px] text-neutral-500 mt-1">{desc}</p>}
    </header>
  )
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="py-4 flex items-start gap-6 border-b border-neutral-100 dark:border-neutral-800/60 last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium text-neutral-800 dark:text-neutral-100">
          {label}
        </div>
        {hint && <div className="text-[13px] text-neutral-500 mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SelectBox({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative inline-block">
      <select
        {...props}
        className={clsx(
          'appearance-none h-8 pl-2.5 pr-8 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[13px] text-neutral-800 dark:text-neutral-100 disabled:opacity-50 cursor-pointer',
          className,
        )}
      >
        {children}
      </select>
      <CaretDown
        weight="bold"
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-neutral-500"
      />
    </div>
  )
}
