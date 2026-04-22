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
import type { ComponentProps } from 'react'

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
