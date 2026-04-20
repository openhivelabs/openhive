import { NextResponse } from 'next/server'
import { getProvider } from '@/lib/server/auth/providers'
import { deleteToken } from '@/lib/server/tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ providerId: string }> },
) {
  const { providerId } = await ctx.params
  if (!getProvider(providerId)) {
    return NextResponse.json({ detail: 'unknown provider' }, { status: 404 })
  }
  return NextResponse.json({ removed: deleteToken(providerId) })
}
