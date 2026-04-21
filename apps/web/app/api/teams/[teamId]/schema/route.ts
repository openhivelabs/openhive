import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { describeSchema } from '@/lib/server/team-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const r = resolveTeamSlugs(teamId)
  if (!r) {
    return NextResponse.json(
      { detail: `team not found: ${teamId}` },
      { status: 404 },
    )
  }
  return NextResponse.json(describeSchema(r.companySlug, r.teamSlug))
}
