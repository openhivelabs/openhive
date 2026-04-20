import { NextResponse } from 'next/server'
import { eventsFor } from '@/lib/server/runs-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params
  return NextResponse.json(eventsFor(runId))
}
