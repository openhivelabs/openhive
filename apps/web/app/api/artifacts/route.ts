import { NextResponse } from 'next/server'
import { listForSession, listForTeam } from '@/lib/server/artifacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('session_id')
  const teamId = url.searchParams.get('team_id')
  if (sessionId) return NextResponse.json(listForSession(sessionId))
  if (teamId) return NextResponse.json(listForTeam(teamId))
  return NextResponse.json(
    { detail: 'team_id or session_id required' },
    { status: 400 },
  )
}
