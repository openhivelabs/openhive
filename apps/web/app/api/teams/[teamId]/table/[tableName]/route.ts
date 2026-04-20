import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { runQuery } from '@/lib/server/team-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SAFE_TABLE = /^[A-Za-z0-9_]+$/

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string; tableName: string }> },
) {
  const { teamId, tableName } = await ctx.params
  if (!SAFE_TABLE.test(tableName)) {
    return NextResponse.json({ detail: 'invalid table name' }, { status: 400 })
  }
  const r = resolveTeamSlugs(teamId)
  if (!r) {
    return NextResponse.json(
      { detail: `team not found: ${teamId}` },
      { status: 404 },
    )
  }
  const limitRaw = new URL(req.url).searchParams.get('limit') ?? '200'
  const limit = Math.max(1, Math.min(10_000, Number.parseInt(limitRaw, 10) || 200))
  const sql = `SELECT * FROM ${tableName} ORDER BY rowid DESC LIMIT ${limit}`
  return NextResponse.json(runQuery(r.companySlug, r.teamSlug, sql))
}
