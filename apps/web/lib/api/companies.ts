import type { Company, Team } from '@/lib/types'

/** Convert UI Team (camelCase) ⇄ server YAML (snake_case for provider/system fields). */
function teamToServer(team: Team): Record<string, unknown> {
  return {
    id: team.id,
    slug: team.slug,
    name: team.name,
    agents: team.agents.map((a) => ({
      id: a.id,
      role: a.role,
      label: a.label,
      provider_id: a.providerId,
      model: a.model,
      system_prompt: a.systemPrompt,
      skills: a.skills,
      position: a.position,
      max_parallel: a.maxParallel ?? 1,
      persona_name: a.personaName ?? null,
      persona_path: a.personaPath ?? null,
    })),
    edges: team.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    entry_agent_id: team.entryAgentId ?? null,
    allowed_skills: team.allowedSkills ?? [],
    allowed_mcp_servers: team.allowedMcpServers ?? [],
    limits: team.limits ?? { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
  }
}

function teamFromServer(t: Record<string, unknown>): Team {
  const rawAgents = (t.agents as Record<string, unknown>[]) ?? []
  const rawEdges = (t.edges as Record<string, unknown>[]) ?? []
  return {
    id: String(t.id ?? ''),
    slug: String(t.slug ?? t.id ?? ''),
    name: String(t.name ?? ''),
    agents: rawAgents.map((a) => ({
      id: String(a.id ?? ''),
      role: String(a.role ?? ''),
      label: String(a.label ?? ''),
      providerId: String(a.provider_id ?? a.providerId ?? ''),
      model: String(a.model ?? ''),
      systemPrompt: String(a.system_prompt ?? a.systemPrompt ?? ''),
      skills: (a.skills as string[]) ?? [],
      position: (a.position as { x: number; y: number }) ?? { x: 0, y: 0 },
      isActive: Boolean(a.is_active ?? a.isActive ?? false),
      maxParallel: Number(a.max_parallel ?? a.maxParallel ?? 1) || 1,
      personaName: typeof a.persona_name === 'string' && a.persona_name ? a.persona_name : undefined,
      personaPath: typeof a.persona_path === 'string' && a.persona_path ? a.persona_path : undefined,
    })),
    edges: rawEdges.map((e) => ({
      id: String(e.id ?? ''),
      source: String(e.source ?? ''),
      target: String(e.target ?? ''),
    })),
    entryAgentId: (t.entry_agent_id as string | null) ?? null,
    allowedSkills: (t.allowed_skills as string[]) ?? [],
    allowedMcpServers: (t.allowed_mcp_servers as string[]) ?? [],
    limits: (t.limits as { max_tool_rounds_per_turn: number; max_delegation_depth: number } | undefined) ?? {
      max_tool_rounds_per_turn: 8,
      max_delegation_depth: 4,
    },
  }
}

export async function fetchCompanies(): Promise<Company[]> {
  const res = await fetch('/api/companies')
  if (!res.ok) throw new Error(`GET /api/companies ${res.status}`)
  const data = (await res.json()) as Record<string, unknown>[]
  return data.map((c) => ({
    id: String(c.id ?? ''),
    slug: String(c.slug ?? c.id ?? ''),
    name: String(c.name ?? ''),
    teams: ((c.teams as Record<string, unknown>[]) ?? []).map(teamFromServer),
  }))
}

export async function saveTeam(companySlug: string, team: Team): Promise<void> {
  const res = await fetch(`/api/companies/${encodeURIComponent(companySlug)}/teams`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: teamToServer(team) }),
  })
  if (!res.ok) throw new Error(`PUT team ${res.status}`)
}

export async function saveCompany(company: Company): Promise<void> {
  const payload = {
    id: company.id,
    slug: company.slug,
    name: company.name,
    teams: company.teams.map(teamToServer),
  }
  const res = await fetch('/api/companies', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: payload }),
  })
  if (!res.ok) throw new Error(`PUT company ${res.status}`)
}

export async function deleteTeam(companySlug: string, teamSlug: string): Promise<void> {
  const res = await fetch(
    `/api/companies/${encodeURIComponent(companySlug)}/teams/${encodeURIComponent(teamSlug)}`,
    { method: 'DELETE' },
  )
  if (!res.ok && res.status !== 404) throw new Error(`DELETE team ${res.status}`)
}

export async function reorderCompaniesApi(slugs: string[]): Promise<void> {
  const res = await fetch('/api/companies/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: slugs }),
  })
  if (!res.ok) throw new Error(`PUT companies/reorder ${res.status}`)
}

export async function reorderTeamsApi(companySlug: string, teamSlugs: string[]): Promise<void> {
  const res = await fetch(
    `/api/companies/${encodeURIComponent(companySlug)}/teams/reorder`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: teamSlugs }),
    },
  )
  if (!res.ok) throw new Error(`PUT teams/reorder ${res.status}`)
}

export async function deleteCompany(companySlug: string): Promise<void> {
  const res = await fetch(`/api/companies/${encodeURIComponent(companySlug)}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 404) throw new Error(`DELETE company ${res.status}`)
}
