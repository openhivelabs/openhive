import { NextResponse } from 'next/server'
import { listForRun, listForTeam } from '@/lib/server/artifacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const runId = url.searchParams.get('run_id')
  const teamId = url.searchParams.get('team_id')
  if (runId) return NextResponse.json(listForRun(runId))
  if (teamId) return NextResponse.json(listForTeam(teamId))
  return NextResponse.json(
    { detail: 'team_id or run_id required' },
    { status: 400 },
  )
}
