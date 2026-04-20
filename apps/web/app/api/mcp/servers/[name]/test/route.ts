import { NextResponse } from 'next/server'
import { getServer } from '@/lib/server/mcp/config'
import { testConnection } from '@/lib/server/mcp/manager'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params
  const server = getServer(name)
  if (!server) {
    return NextResponse.json({ detail: 'server not found' }, { status: 404 })
  }
  return NextResponse.json(await testConnection(server))
}
