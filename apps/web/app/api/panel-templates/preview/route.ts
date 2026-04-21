import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { apply as applyMapper } from '@/lib/server/panels/mapper'
import { execute as executeSource } from '@/lib/server/panels/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  team_id?: string
  panel_type?: string
  binding?: Record<string, unknown>
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body
  if (typeof body.team_id !== 'string' || !body.team_id) {
    return NextResponse.json({ detail: 'team_id required' }, { status: 400 })
  }
  if (typeof body.panel_type !== 'string' || !body.panel_type) {
    return NextResponse.json({ detail: 'panel_type required' }, { status: 400 })
  }
  if (!body.binding || typeof body.binding !== 'object') {
    return NextResponse.json({ detail: 'binding required' }, { status: 400 })
  }
  const resolved = resolveTeamSlugs(body.team_id)
  if (!resolved) {
    return NextResponse.json({ detail: 'team not found' }, { status: 404 })
  }
  const ctx = {
    companySlug: resolved.companySlug,
    teamSlug: resolved.teamSlug,
    teamId: body.team_id,
  }
  try {
    const raw = await executeSource(body.binding.source ?? {}, ctx)
    const shaped = applyMapper(
      raw,
      (body.binding.map as Record<string, unknown> | undefined) ?? {},
      body.panel_type,
    )
    return NextResponse.json({ ok: true, data: shaped })
  } catch (exc) {
    const name = exc instanceof Error ? exc.name : 'Error'
    const message = exc instanceof Error ? exc.message : String(exc)
    return NextResponse.json({ ok: false, error: `${name}: ${message}` })
  }
}
