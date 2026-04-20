import { NextResponse } from 'next/server'
import { listForTeam } from '@/lib/server/runs-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const teamId = new URL(req.url).searchParams.get('team_id')
  if (!teamId) {
    return NextResponse.json({ detail: 'team_id required' }, { status: 400 })
  }
  return NextResponse.json(listForTeam(teamId))
}
