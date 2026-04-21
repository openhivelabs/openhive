import { NextResponse } from 'next/server'
import { stop } from '@/lib/server/engine/session-registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params
  return NextResponse.json({ ok: await stop(sessionId) })
}
