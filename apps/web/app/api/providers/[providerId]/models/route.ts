import { NextResponse } from 'next/server'
import { getProvider } from '@/lib/server/auth/providers'
import { listModelsFor } from '@/lib/server/providers/models'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ providerId: string }> },
) {
  const { providerId } = await ctx.params
  if (!getProvider(providerId)) {
    return NextResponse.json({ detail: 'unknown provider' }, { status: 404 })
  }
  try {
    return NextResponse.json(await listModelsFor(providerId))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ detail: message }, { status: 500 })
  }
}
