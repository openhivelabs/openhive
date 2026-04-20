import { NextResponse } from 'next/server'
import { saveTeam, type TeamDict } from '@/lib/server/companies'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface SaveTeamBody {
  team?: TeamDict
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await ctx.params
  const body = (await req.json()) as SaveTeamBody
  const team = body?.team
  if (!team || typeof team !== 'object') {
    return NextResponse.json({ detail: 'team body required' }, { status: 400 })
  }
  if (!team.slug && !team.id) {
    return NextResponse.json(
      { detail: 'team.slug or team.id required' },
      { status: 400 },
    )
  }
  saveTeam(companySlug, team)
  return NextResponse.json({ ok: true })
}
