import { NextResponse } from 'next/server'
import { refreshOneNow } from '@/lib/server/panels/refresher'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ panelId: string }> },
) {
  const { panelId } = await ctx.params
  const result = await refreshOneNow(panelId)
  if (!result) {
    return NextResponse.json(
      { detail: 'block not found or has no binding' },
      { status: 404 },
    )
  }
  return NextResponse.json(result)
}
