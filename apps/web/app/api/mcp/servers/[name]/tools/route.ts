import { NextResponse } from 'next/server'
import { getTools } from '@/lib/server/mcp/manager'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params
  try {
    const tools = await getTools(name)
    return NextResponse.json({
      name,
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = msg.includes('not configured') ? 404 : 502
    return NextResponse.json({ detail: msg }, { status })
  }
}
