import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { installTemplate } from '@/lib/server/team-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface InstallBody {
  template?: string
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
  const body = (await req.json()) as InstallBody
  if (typeof body.template !== 'string' || !body.template.trim()) {
    return NextResponse.json({ detail: 'template name required' }, { status: 400 })
  }
  try {
    return NextResponse.json(
      installTemplate(r.companySlug, r.teamSlug, body.template),
    )
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return NextResponse.json({ detail: message }, { status })
  }
}
