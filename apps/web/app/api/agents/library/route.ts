import { NextResponse } from 'next/server'
import { companyDir } from '@/lib/server/paths'
import { listPersonas } from '@/lib/server/agents/loader'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export async function GET(req: Request) {
  const url = new URL(req.url)
  const companySlug = url.searchParams.get('company') ?? null
  const compDir = companySlug ? companyDir(companySlug) : null
  const personas = listPersonas(compDir)
  const out: LibraryPersona[] = []
  for (const p of personas.values()) {
    out.push({
      name: p.name,
      description: p.description,
      kind: p.kind,
      source: p.source,
      path: p.path,
      file_tree: p.file_tree,
      model: p.model,
      skills: p.tools.skills,
      mcp_servers: p.tools.mcp_servers,
    })
  }
  // Keep a stable order: bundled first, then company, then user.
  const rank = { bundled: 0, company: 1, user: 2, inline: 3 }
  out.sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name))
  return NextResponse.json(out)
}
