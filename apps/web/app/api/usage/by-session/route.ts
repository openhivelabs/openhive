import { NextResponse } from 'next/server'
import { usageForSessions } from '@/lib/server/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const raw = url.searchParams.get('session_ids') ?? ''
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return NextResponse.json(usageForSessions(ids))
}
