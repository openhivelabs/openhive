import { type CompanyDict, deleteCompany, listCompanies, saveCompany } from '@/lib/server/companies'
import { Hono } from 'hono'

export const companies = new Hono()

interface SaveCompanyBody {
  company?: CompanyDict
}

// GET /api/companies — list
companies.get('/', (c) => c.json(listCompanies()))

// PUT /api/companies — save (create or update)
companies.put('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SaveCompanyBody
  const company = body?.company
  if (!company || typeof company !== 'object') {
    return c.json({ detail: 'company body required' }, 400)
  }
  if (!company.slug && !company.id) {
    return c.json({ detail: 'company.slug or company.id required' }, 400)
  }
  saveCompany(company)
  return c.json({ ok: true })
})

// DELETE /api/companies/:companySlug
companies.delete('/:companySlug', (c) => {
  const companySlug = c.req.param('companySlug')
  const ok = deleteCompany(companySlug)
  if (!ok) {
    return c.json({ detail: 'Company not found' }, 404)
  }
  return c.json({ ok: true })
})
