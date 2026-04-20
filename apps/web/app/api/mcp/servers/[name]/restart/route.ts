import { NextResponse } from 'next/server'
import { restart } from '@/lib/server/mcp/manager'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params
  await restart(name)
  return NextResponse.json({ ok: true })
}
