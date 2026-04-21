import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import {
  createSnapshot,
  discardSnapshot,
  hasSnapshot,
} from '@/lib/server/snapshots'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function notFound(teamId: string) {
  return NextResponse.json(
    { detail: `team not found: ${teamId}` },
    { status: 404 },
  )
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const r = resolveTeamSlugs(teamId)
  if (!r) return notFound(teamId)
  return NextResponse.json({ exists: hasSnapshot(r.companySlug, r.teamSlug) })
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const r = resolveTeamSlugs(teamId)
  if (!r) return notFound(teamId)
  return NextResponse.json({
    ok: true,
    files: createSnapshot(r.companySlug, r.teamSlug),
  })
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const r = resolveTeamSlugs(teamId)
  if (!r) return notFound(teamId)
  return NextResponse.json({
    ok: discardSnapshot(r.companySlug, r.teamSlug),
  })
}
