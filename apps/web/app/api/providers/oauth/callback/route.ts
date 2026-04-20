import { NextResponse } from 'next/server'
import { callbackHtml, handleCallback } from '@/lib/server/auth/orchestrator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const result = await handleCallback({
    code: params.get('code'),
    state: params.get('state'),
    flowId: params.get('flow_id'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  })
  return new NextResponse(callbackHtml(result.ok, result.message), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
