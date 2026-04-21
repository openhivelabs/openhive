import { NextResponse } from 'next/server'
import { deleteCompany } from '@/lib/server/companies'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await ctx.params
  const ok = deleteCompany(companySlug)
  if (!ok) {
    return NextResponse.json({ detail: 'Company not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
