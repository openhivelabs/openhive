import {
  Atom,
  Briefcase,
  Brain,
  ChartBar,
  Cube,
  Flag,
  Flask,
  Globe,
  Lightbulb,
  Lightning,
  Megaphone,
  PaintBrush,
  Rocket,
  Scales,
  Star,
  Target,
  Users,
  Wrench,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { type ComponentProps, useState } from 'react'
import { useT } from '@/lib/i18n'

/** 팀 사이드바 아이콘 선택지. 키는 YAML 에 저장되는 식별자. 여기 없는 값이
 *  들어오면 fallback 으로 Users. 추가할 땐 이 맵에 엔트리만 더 넣으면 된다. */
export const TEAM_ICONS: Record<string, PhosphorIcon> = {
  users: Users,
  rocket: Rocket,
  flag: Flag,
  flask: Flask,
  brain: Brain,
  chart: ChartBar,
  briefcase: Briefcase,
  cube: Cube,
  lightning: Lightning,
  paintBrush: PaintBrush,
  globe: Globe,
  megaphone: Megaphone,
  star: Star,
  target: Target,
  lightbulb: Lightbulb,
  atom: Atom,
  wrench: Wrench,
  scales: Scales,
}

export const DEFAULT_TEAM_ICON_KEY = 'users'

export function resolveTeamIcon(name?: string): PhosphorIcon {
  if (!name) return Users
  return TEAM_ICONS[name] ?? Users
}

interface TeamIconProps extends Omit<ComponentProps<PhosphorIcon>, 'ref'> {
  name?: string
}

export function TeamIcon({ name, ...rest }: TeamIconProps) {
  const Icon = resolveTeamIcon(name)
  return <Icon {...rest} />
}

/** Icon-only button that opens a popover grid for picking a team icon.
 *  Used from TeamSettingsModal and NewTeamModal — both places let the user
 *  pick from the same small library defined in TEAM_ICONS. */
export function IconPickerButton({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (key: string) => void
  className?: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const Current = resolveTeamIcon(value)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('sidebar.selectTeamIcon')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={clsx(
          'h-full w-10 flex items-center justify-center rounded-sm border border-neutral-300 text-neutral-700 hover:bg-neutral-50',
          className,
        )}
      >
        <Current className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            className="absolute left-0 top-[calc(100%+4px)] z-50 w-[260px] rounded-md border border-neutral-200 bg-white shadow-lg p-2 grid grid-cols-6 gap-1"
          >
            {Object.entries(TEAM_ICONS).map(([key, Icon]) => {
              const isActive = key === value
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    onChange(key)
                    setOpen(false)
                  }}
                  aria-label={key}
                  title={key}
                  className={clsx(
                    'w-9 h-9 rounded-sm flex items-center justify-center transition-colors',
                    isActive
                      ? 'bg-neutral-900 text-white'
                      : 'text-neutral-600 hover:bg-neutral-100',
                  )}
                >
                  <Icon className="w-4 h-4" />
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
