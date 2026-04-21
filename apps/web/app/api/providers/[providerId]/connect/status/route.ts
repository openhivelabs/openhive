import { NextResponse } from 'next/server'
import { getFlow } from '@/lib/server/auth/flows'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  ctx: { params: Promise<{ providerId: string }> },
) {
  const { providerId } = await ctx.params
  const flowId = new URL(req.url).searchParams.get('flow_id')
  if (!flowId) {
    return NextResponse.json({ detail: 'flow_id required' }, { status: 400 })
  }
  const flow = getFlow(flowId)
  if (!flow || flow.provider_id !== providerId) {
    return NextResponse.json({ detail: 'flow not found' }, { status: 404 })
  }
  return NextResponse.json({
    status: flow.status,
    error: flow.error,
    account_label: flow.account_label ?? null,
  })
}
