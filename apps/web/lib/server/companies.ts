/**
 * Company/team YAML store. Ports apps/server/openhive/persistence/companies.py.
 *
 * Layout on disk (unchanged from the Python side — shared between runtimes
 * during migration):
 *   ~/.openhive/companies/
 *   └── {company-slug}/
 *       ├── company.yaml                { id, slug, name }
 *       └── teams/
 *           └── {team-slug}.yaml        { id, slug, name, agents, edges, … }
 *
 * (The per-team directory at teams/{team-slug}/ is owned by dashboards.ts,
 * team_data.ts, and frame persona bundles — coexists with the sibling YAML.)
 */

import fs from 'node:fs'
import path from 'node:path'
import { companiesRoot, companyDir, teamYamlPath } from './paths'
import { invalidateCachePrefix, readYamlCached, writeYaml } from './yaml-io'

export interface TeamDict extends Record<string, unknown> {
  id?: string
  slug?: string
  name?: string
}

export interface CompanyDict extends Record<string, unknown> {
  id?: string
  slug?: string
  name?: string
  teams?: TeamDict[]
}

function ensureRoot(): string {
  const root = companiesRoot()
  fs.mkdirSync(root, { recursive: true })
  return root
}

export function listCompanies(): CompanyDict[] {
  const root = ensureRoot()
  const out: CompanyDict[] = []
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const compDir = path.join(root, entry.name)
    const meta =
      (readYamlCached(path.join(compDir, 'company.yaml')) as CompanyDict | null) ?? {
        id: entry.name,
        slug: entry.name,
        name: entry.name,
      }
    const teamsDir = path.join(compDir, 'teams')
    const teams: TeamDict[] = []
    if (fs.existsSync(teamsDir) && fs.statSync(teamsDir).isDirectory()) {
      const files = fs
        .readdirSync(teamsDir)
        .filter((f) => f.endsWith('.yaml'))
        .sort()
      for (const f of files) {
        const t = readYamlCached(path.join(teamsDir, f)) as TeamDict | null
        if (t) teams.push(t)
      }
    }
    meta.teams = teams
    out.push(meta)
  }
  return out
}

export function saveTeam(companySlug: string, team: TeamDict): void {
  const slug = team.slug ?? team.id ?? 'team'
  writeYaml(teamYamlPath(companySlug, String(slug)), team)
}

export function saveCompany(company: CompanyDict): void {
  const slug = company.slug ?? company.id ?? 'company'
  const teams = company.teams ?? []
  const meta: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(company)) {
    if (k !== 'teams') meta[k] = v
  }
  writeYaml(path.join(companyDir(String(slug)), 'company.yaml'), meta)
  for (const t of teams) saveTeam(String(slug), t)
}

export function deleteTeam(companySlug: string, teamSlug: string): boolean {
  const p = teamYamlPath(companySlug, teamSlug)
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    fs.unlinkSync(p)
    invalidateCachePrefix(p)
    return true
  }
  return false
}

export function deleteCompany(companySlug: string): boolean {
  const dir = companyDir(companySlug)
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    fs.rmSync(dir, { recursive: true, force: true })
    invalidateCachePrefix(dir)
    return true
  }
  return false
}

/**
 * Resolve a team id → (companySlug, teamSlug). Linear scan; fine because
 * company count is tiny (<~50) and the result is cached per YAML file via
 * readYamlCached.
 */
export function resolveTeamSlugs(
  teamId: string,
): { companySlug: string; teamSlug: string } | null {
  for (const company of listCompanies()) {
    for (const t of company.teams ?? []) {
      if (t.id === teamId && company.slug && t.slug) {
        return { companySlug: String(company.slug), teamSlug: String(t.slug) }
      }
    }
  }
  return null
}
