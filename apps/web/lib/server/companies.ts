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
  order?: number
}

export interface CompanyDict extends Record<string, unknown> {
  id?: string
  slug?: string
  name?: string
  teams?: TeamDict[]
  order?: number
}

function byOrderThenName<T extends { order?: unknown; name?: unknown; slug?: unknown }>(a: T, b: T): number {
  const ao = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER
  const bo = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  const an = String(a.name ?? a.slug ?? '')
  const bn = String(b.name ?? b.slug ?? '')
  return an < bn ? -1 : an > bn ? 1 : 0
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
    teams.sort(byOrderThenName)
    meta.teams = teams
    out.push(meta)
  }
  out.sort(byOrderThenName)
  return out
}

/**
 * Reorder companies by slug. Missing slugs keep their current relative order
 * appended after the requested ones. Writes `order: i` into each company.yaml.
 */
export function reorderCompanies(slugs: string[]): void {
  const root = ensureRoot()
  const existing = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const s of slugs) {
    if (existing.includes(s) && !seen.has(s)) {
      ordered.push(s)
      seen.add(s)
    }
  }
  for (const s of existing) if (!seen.has(s)) ordered.push(s)

  ordered.forEach((slug, i) => {
    const yamlPath = path.join(companyDir(slug), 'company.yaml')
    const meta = (readYamlCached(yamlPath) as CompanyDict | null) ?? {
      id: slug,
      slug,
      name: slug,
    }
    meta.order = i
    writeYaml(yamlPath, meta)
  })
}

/**
 * Reorder teams within a company by slug. Writes `order: i` into each team YAML.
 */
export function reorderTeams(companySlug: string, teamSlugs: string[]): void {
  const teamsDir = path.join(companyDir(companySlug), 'teams')
  if (!fs.existsSync(teamsDir) || !fs.statSync(teamsDir).isDirectory()) return
  const existing = fs
    .readdirSync(teamsDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const s of teamSlugs) {
    if (existing.includes(s) && !seen.has(s)) {
      ordered.push(s)
      seen.add(s)
    }
  }
  for (const s of existing) if (!seen.has(s)) ordered.push(s)

  ordered.forEach((slug, i) => {
    const p = teamYamlPath(companySlug, slug)
    const team = (readYamlCached(p) as TeamDict | null) ?? { id: slug, slug, name: slug }
    team.order = i
    writeYaml(p, team)
  })
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
