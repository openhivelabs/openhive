import { NextResponse } from 'next/server'
import { deleteServer, upsertServer } from '@/lib/server/mcp/config'
import { restart } from '@/lib/server/mcp/manager'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface UpsertBody {
  server?: Record<string, unknown>
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params
  const body = (await req.json()) as UpsertBody
  if (!body.server || typeof body.server !== 'object') {
    return NextResponse.json({ detail: 'server body required' }, { status: 400 })
  }
  try {
    upsertServer(name, body.server as Parameters<typeof upsertServer>[1])
  } catch (err) {
    return NextResponse.json(
      { detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    )
  }
  await restart(name)
  return NextResponse.json({ ok: true, name })
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params
  await restart(name)
  if (!deleteServer(name)) {
    return NextResponse.json({ detail: 'server not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
