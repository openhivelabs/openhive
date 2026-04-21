import { NextResponse } from 'next/server'
import {
  listSessions,
  listSessionsFor,
} from '@/lib/server/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const teamId = url.searchParams.get('team_id')
  const taskId = url.searchParams.get('task_id')
  const limit = Number(url.searchParams.get('limit') ?? 200)
  if (teamId || taskId) {
    return NextResponse.json(
      listSessionsFor({
        teamId,
        taskId,
        limit: Number.isFinite(limit) ? limit : 200,
      }),
    )
  }
  return NextResponse.json(listSessions(Number.isFinite(limit) ? limit : 200))
}
