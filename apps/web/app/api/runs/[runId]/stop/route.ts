import { NextResponse } from 'next/server'
import { stop } from '@/lib/server/engine/run-registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params
  return NextResponse.json({ ok: await stop(runId) })
}
