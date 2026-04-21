import { NextResponse } from 'next/server'
import { listPresets } from '@/lib/server/mcp/presets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    listPresets().map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      brand: p.brand,
      icon_url: p.icon_url,
      description: p.description,
      coming_soon: p.coming_soon,
      inputs: p.inputs.map((i) => ({
        key: i.key,
        label: i.label,
        type: i.type,
        placeholder: i.placeholder,
        help_text: i.help_text,
        required: i.required,
      })),
    })),
  )
}
