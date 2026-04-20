import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { loadDashboard, saveDashboard } from '@/lib/server/dashboards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const resolved = resolveTeamSlugs(teamId)
  if (!resolved) {
    return NextResponse.json(
      { detail: `team not found: ${teamId}` },
      { status: 404 },
    )
  }
  const layout = loadDashboard(resolved.companySlug, resolved.teamSlug)
  return NextResponse.json({ layout })
}

interface SaveLayoutBody {
  layout?: Record<string, unknown>
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const resolved = resolveTeamSlugs(teamId)
  if (!resolved) {
    return NextResponse.json(
      { detail: `team not found: ${teamId}` },
      { status: 404 },
    )
  }
  const body = (await req.json()) as SaveLayoutBody
  if (!body.layout || typeof body.layout !== 'object') {
    return NextResponse.json({ detail: 'layout required' }, { status: 400 })
  }
  saveDashboard(resolved.companySlug, resolved.teamSlug, body.layout)
  return NextResponse.json({ ok: true })
}
