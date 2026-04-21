import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { validateTeam } from '@/lib/server/engine/preflight'
import { start as startRegistryRun } from '@/lib/server/engine/session-registry'
import { toTeamSpec } from '@/lib/server/engine/team'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface StartBody {
  team?: Record<string, unknown>
  goal?: string
  locale?: string
  task_id?: string
}

export async function POST(req: Request) {
  const body = (await req.json()) as StartBody
  if (!body.team || typeof body.team !== 'object') {
    return NextResponse.json({ detail: 'team required' }, { status: 400 })
  }
  if (typeof body.goal !== 'string' || !body.goal.trim()) {
    return NextResponse.json({ detail: 'goal required' }, { status: 400 })
  }
  const team = toTeamSpec(body.team)
  const issues = validateTeam(team)
  if (issues.length > 0) {
    return NextResponse.json(
      { detail: { preflight: issues } },
      { status: 400 },
    )
  }
  const resolved = resolveTeamSlugs(team.id)
  const teamSlugs: [string, string] | null = resolved
    ? [resolved.companySlug, resolved.teamSlug]
    : null
  try {
    const sessionId = await startRegistryRun(
      team,
      body.goal,
      teamSlugs,
      body.locale ?? 'en',
      typeof body.task_id === 'string' && body.task_id ? body.task_id : null,
    )
    return NextResponse.json({ session_id: sessionId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ detail: message }, { status: 500 })
  }
}
