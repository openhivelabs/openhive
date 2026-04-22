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
  const params = new URL(req.url).searchParams
  const limit = Math.max(
    1,
    Math.min(1000, Number.parseInt(params.get('limit') ?? '100', 10) || 100),
  )
  const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0)
  const pageSql = `SELECT * FROM ${tableName} ORDER BY rowid DESC LIMIT ${limit} OFFSET ${offset}`
  const page = runQuery(r.companySlug, r.teamSlug, pageSql)
  const countSql = `SELECT COUNT(*) AS c FROM ${tableName}`
  const countRes = runQuery(r.companySlug, r.teamSlug, countSql)
  const total = Number((countRes.rows[0] ?? { c: 0 }).c ?? 0)
  return NextResponse.json({
    columns: page.columns,
    rows: page.rows,
    total,
    limit,
    offset,
  })
}
