import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { runQuery } from '@/lib/server/team-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface SqlBody {
  sql?: string
}

export async function POST(
  req: Request,
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
  const body = (await req.json()) as SqlBody
  if (typeof body.sql !== 'string' || !body.sql.trim()) {
    return NextResponse.json({ detail: 'sql required' }, { status: 400 })
  }
  try {
    return NextResponse.json(runQuery(r.companySlug, r.teamSlug, body.sql))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ detail: message }, { status: 400 })
  }
}
