import { NextResponse } from 'next/server'
import { getProvider } from '@/lib/server/auth/providers'
import { startConnect } from '@/lib/server/auth/orchestrator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  ctx: { params: Promise<{ providerId: string }> },
) {
  const { providerId } = await ctx.params
  if (!getProvider(providerId)) {
    return NextResponse.json({ detail: 'unknown provider' }, { status: 404 })
  }
  // Build the callback URI from the current request origin. Matches the Python
  // side which used `request.base_url` — so redirect URIs consistently point
  // at the host the browser reached, whatever port/hostname that is.
  const origin = new URL(req.url).origin
  const callbackUri = `${origin}/api/providers/oauth/callback`
  try {
    return NextResponse.json(await startConnect(providerId, callbackUri))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ detail: message }, { status: 400 })
  }
}
