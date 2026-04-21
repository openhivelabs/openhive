import { NextResponse } from 'next/server'
import { eventsForSession } from '@/lib/server/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params
  return NextResponse.json(eventsForSession(sessionId))
}
