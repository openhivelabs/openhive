import type { Artifact } from '@/lib/types'

interface ServerArtifact {
  id: string
  session_id: string
  team_id: string
  company_slug: string | null
  team_slug: string | null
  skill_name: string | null
  filename: string
  path: string
  mime: string | null
  size: number | null
  created_at: number // unix ms
}

function fromServer(a: ServerArtifact): Artifact {
  return {
    id: a.id,
    teamId: a.team_id,
    sessionId: a.session_id,
    filename: a.filename,
    path: a.path,
    mime: a.mime ?? 'application/octet-stream',
    createdAt: new Date(a.created_at).toISOString(),
  }
}

export async function fetchArtifactsForTeam(teamId: string): Promise<Artifact[]> {
  const res = await fetch(`/api/artifacts?team_id=${encodeURIComponent(teamId)}`)
  if (!res.ok) throw new Error(`GET /api/artifacts ${res.status}`)
  const data = (await res.json()) as ServerArtifact[]
  return data.map(fromServer)
}

// Richer artifact shape used by the Files view — keeps size / skill /
// created_at for sorting and preview without changing the shared Artifact type
// that other callers depend on.
export interface ArtifactDetailed {
  id: string
  sessionId: string
  teamId: string
  skillName: string | null
  filename: string
  path: string
  mime: string | null
  size: number | null
  createdAt: number
}

export async function fetchArtifactsDetailed(teamId: string): Promise<ArtifactDetailed[]> {
  const res = await fetch(`/api/artifacts?team_id=${encodeURIComponent(teamId)}`)
  if (!res.ok) throw new Error(`GET /api/artifacts ${res.status}`)
  const data = (await res.json()) as ServerArtifact[]
  return data.map((a) => ({
    id: a.id,
    sessionId: a.session_id,
    teamId: a.team_id,
    skillName: a.skill_name,
    filename: a.filename,
    path: a.path,
    mime: a.mime,
    size: a.size,
    createdAt: a.created_at,
  }))
}

export function downloadUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/download`
}
