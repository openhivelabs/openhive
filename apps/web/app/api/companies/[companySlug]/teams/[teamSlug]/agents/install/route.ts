import { NextResponse } from 'next/server'
import { installAgentFrame } from '@/lib/server/agent-frames'
import { listConnected } from '@/lib/server/tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface InstallBody {
  frame?: unknown
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ companySlug: string; teamSlug: string }> },
) {
  const { companySlug, teamSlug } = await ctx.params
  const body = (await req.json()) as InstallBody
  if (!body.frame) {
    return NextResponse.json({ detail: 'frame required' }, { status: 400 })
  }
  try {
    const result = installAgentFrame(companySlug, teamSlug, body.frame, {
      connectedProviders: new Set(listConnected()),
    })
    return NextResponse.json(result)
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return NextResponse.json({ detail: message }, { status })
  }
}
