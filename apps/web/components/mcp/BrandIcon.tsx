import type { ComponentType } from 'react'
import type { IconBaseProps } from 'react-icons'
import { SiGmail, SiHubspot, SiNotion, SiSlack, SiSupabase } from 'react-icons/si'

/** Map of preset brand id → simple-icons React component.
 *
 * Add new brands here as new MCP server presets land. We use named imports so
 * the bundler tree-shakes — the bundle stays in single-digit KB even if the
 * map grows to many entries. */
const BRANDS: Record<string, ComponentType<IconBaseProps>> = {
  notion: SiNotion,
  supabase: SiSupabase,
  slack: SiSlack,
  hubspot: SiHubspot,
  gmail: SiGmail,
}

/** Inherits color from currentColor by default; pass `color` for the official
 * brand hex (e.g. Notion = #000000, Supabase = #3FCF8E). The simple-icons
 * components accept `color` directly. */
export function BrandIcon({
  brand,
  className,
  color,
}: {
  brand: string
  className?: string
  color?: string
}) {
  const Icon = BRANDS[brand]
  if (!Icon) return null
  return <Icon className={className} color={color} />
}

export function hasBrand(brand: string): boolean {
  return brand in BRANDS
}

/** Official brand colors. Used to tint the icon on cards so the user instantly
 * recognises the service. */
export const BRAND_COLORS: Record<string, string> = {
  notion: '#000000',
  supabase: '#3FCF8E',
  slack: '#4A154B',
  hubspot: '#FF7A59',
  gmail: '#EA4335',
}
