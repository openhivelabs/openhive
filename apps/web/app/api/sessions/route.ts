import { NextResponse } from 'next/server'
import { listSessions } from '@/lib/server/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const limit = Number(url.searchParams.get('limit') ?? 100)
  return NextResponse.json(listSessions(Number.isFinite(limit) ? limit : 100))
}
