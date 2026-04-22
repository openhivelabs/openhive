export interface LibraryPersona {
  name: string
  description: string
  kind: 'file' | 'dir'
  source: 'bundled' | 'company' | 'user' | 'inline'
  path: string
  file_tree: string[]
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
