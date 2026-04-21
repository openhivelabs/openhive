import { NextResponse } from 'next/server'
import { get } from '@/lib/server/panels/cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ panelId: string }> },
) {
  const { panelId } = await ctx.params
  const row = get(panelId)
  if (!row) {
    return NextResponse.json({
      panel_id: panelId,
      data: null,
      error: null,
      fetched_at: null,
    })
  }
  return NextResponse.json(row)
}
