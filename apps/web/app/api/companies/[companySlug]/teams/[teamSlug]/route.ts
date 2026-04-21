import { NextResponse } from 'next/server'
import { deleteTeam } from '@/lib/server/companies'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ companySlug: string; teamSlug: string }> },
) {
  const { companySlug, teamSlug } = await ctx.params
  const ok = deleteTeam(companySlug, teamSlug)
  if (!ok) {
    return NextResponse.json({ detail: 'Team not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
