import { NextResponse } from 'next/server'
import { listCompanies, saveCompany, type CompanyDict } from '@/lib/server/companies'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listCompanies())
}

interface SaveCompanyBody {
  company?: CompanyDict
}

export async function PUT(req: Request) {
  const body = (await req.json()) as SaveCompanyBody
  const company = body?.company
  if (!company || typeof company !== 'object') {
    return NextResponse.json(
      { detail: 'company body required' },
      { status: 400 },
    )
  }
  if (!company.slug && !company.id) {
    return NextResponse.json(
      { detail: 'company.slug or company.id required' },
      { status: 400 },
    )
  }
  saveCompany(company)
  return NextResponse.json({ ok: true })
}
