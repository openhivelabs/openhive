import { NextResponse } from 'next/server'
import { listTemplates } from '@/lib/server/panels/templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      category: t.category,
      panel: t.block,
      binding_skeleton: t.binding_skeleton,
      ai_prompts: t.ai_prompts,
    })),
  )
}
