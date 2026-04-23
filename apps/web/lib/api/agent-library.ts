export interface LibraryPersona {
  name: string
  description: string
  kind: 'file' | 'dir'
  source: 'bundled' | 'company' | 'user' | 'inline'
  path: string
  file_tree: string[]
  body: string
  model: string | null
  skills: string[]
  mcp_servers: string[]
}

export async function listAgentLibrary(companySlug?: string): Promise<LibraryPersona[]> {
  const q = companySlug ? `?company=${encodeURIComponent(companySlug)}` : ''
  const res = await fetch(`/api/agents/library${q}`)
  if (!res.ok) throw new Error(`GET /api/agents/library ${res.status}`)
  return (await res.json()) as LibraryPersona[]
}

/** Persist a new AGENT.md body (frontmatter preserved server-side). */
export async function saveAgentBody(personaPath: string, body: string): Promise<void> {
  const res = await fetch('/api/agents/persona/body', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona_path: personaPath, body }),
  })
  if (!res.ok) throw new Error(`PUT persona/body ${res.status}: ${await res.text()}`)
}

/** Load every .md file inside a persona bundle (for the edit tree view). */
export async function getPersonaFiles(personaPath: string): Promise<Record<string, string>> {
  const res = await fetch(
    `/api/agents/persona/files?persona_path=${encodeURIComponent(personaPath)}`,
  )
  if (!res.ok) throw new Error(`GET persona/files ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { files?: Record<string, string> }
  return body.files ?? {}
}

/** Create a fresh persona bundle on disk. Returns the assigned path + name. */
export async function createPersonaBundle(
  companySlug: string,
  role: string,
  agentId: string,
  files: Record<string, string>,
): Promise<{ persona_path: string; persona_name: string | null }> {
  const res = await fetch('/api/agents/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_slug: companySlug, role, agent_id: agentId, files }),
  })
  if (!res.ok) throw new Error(`POST persona ${res.status}: ${await res.text()}`)
  return (await res.json()) as { persona_path: string; persona_name: string | null }
}

/** Rewrite the full .md file set of an existing persona bundle (add / delete / edit). */
export async function savePersonaFiles(
  personaPath: string,
  files: Record<string, string>,
): Promise<void> {
  const res = await fetch('/api/agents/persona/files', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona_path: personaPath, files }),
  })
  if (!res.ok) throw new Error(`PUT persona/files ${res.status}: ${await res.text()}`)
}
