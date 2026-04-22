export interface RecipeParam {
  name: string
  label: string
  type: 'text' | 'number' | 'select'
  default?: unknown
  options?: string[]
  required?: boolean
}

export interface Recipe {
  id: string
  label: string
  icon?: string
  category?: string
  description?: string
  requires?: { mcp_server?: string; auth_ref?: string }
  panel: Record<string, unknown>
  params?: RecipeParam[]
}

export interface CatalogResponse {
  mcp_servers: {
    id: string
    label: string
    connected: boolean
    tools: { name: string; description: string; mutates: boolean }[]
  }[]
  mcp_registry: {
    id: string
    label: string
    icon?: string
    category?: string
    package: string
    auth: string
    description?: string
  }[]
  team_tables: unknown[]
  team_files: string[]
  credentials: { ref_id: string; kind: string; label?: string; added_at: number }[]
  recipes: Recipe[]
}

export async function fetchComposerCatalog(teamId: string): Promise<CatalogResponse> {
  const res = await fetch(
    `/api/composer/catalog?teamId=${encodeURIComponent(teamId)}`,
  )
  if (!res.ok) throw new Error(`GET catalog ${res.status}`)
  return (await res.json()) as CatalogResponse
}

export async function installRecipe(
  teamId: string,
  recipeId: string,
  params?: Record<string, unknown>,
  title?: string,
): Promise<void> {
  const res = await fetch('/api/composer/install-recipe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, recipeId, params, title }),
  })
  const body = (await res.json().catch(() => ({}))) as { detail?: string }
  if (!res.ok) throw new Error(body.detail ?? `install-recipe ${res.status}`)
}
