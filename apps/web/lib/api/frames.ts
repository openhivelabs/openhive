import yaml from 'js-yaml'
import type { Team } from '@/lib/types'

/** Trigger a download of a team as an .openhive-frame.yaml file. */
export function downloadFrame(companySlug: string, teamSlug: string): void {
  const url = `/api/companies/${encodeURIComponent(companySlug)}/teams/${encodeURIComponent(teamSlug)}/frame`
  // Plain anchor click — backend already sets Content-Disposition with the filename.
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

interface FrameRequires {
  skills: string[]
  providers: string[]
}

export interface FramePreview {
  raw: unknown
  name: string
  description: string
  version: string
  agentCount: number
  hasDashboard: boolean
  schemaStatementCount: number
  requires: FrameRequires
}

/** Parse a frame YAML file in the browser and surface a small preview struct.
 *  Throws if the file isn't a recognisable frame. */
export async function parseFrameFile(file: File): Promise<FramePreview> {
  const text = await file.text()
  let raw: unknown
  try {
    raw = yaml.load(text)
  } catch (e) {
    throw new Error(`Could not parse YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Frame file is empty or malformed.')
  }
  const r = raw as Record<string, unknown>
  if (r.openhive_frame !== 1) {
    throw new Error(
      `Unsupported frame version: ${String(r.openhive_frame)}. This hive expects version 1.`,
    )
  }
  const team = (r.team as Record<string, unknown>) || {}
  const requires = (r.requires as Record<string, unknown>) || {}
  return {
    raw,
    name: String(r.name ?? team.name ?? 'Untitled frame'),
    description: String(r.description ?? ''),
    version: String(r.version ?? '1.0.0'),
    agentCount: Array.isArray(team.agents) ? team.agents.length : 0,
    hasDashboard: !!r.dashboard && typeof r.dashboard === 'object',
    schemaStatementCount: Array.isArray(r.data_schema) ? (r.data_schema as unknown[]).length : 0,
    requires: {
      skills: Array.isArray(requires.skills) ? (requires.skills as string[]) : [],
      providers: Array.isArray(requires.providers) ? (requires.providers as string[]) : [],
    },
  }
}

export interface GalleryEntry {
  id: string
  name: string
  description: string
  version: string
  tags: string[]
  agent_count: number
  has_dashboard: boolean
  requires: FrameRequires
  frame: unknown
}

export async function listGallery(): Promise<GalleryEntry[]> {
  const res = await fetch('/api/frames/gallery')
  if (!res.ok) throw new Error(`GET /api/frames/gallery ${res.status}`)
  return (await res.json()) as GalleryEntry[]
}

interface InstallFrameResult {
  team: Record<string, unknown>
  warnings: string[]
}

export async function installFrame(
  companySlug: string,
  frame: unknown,
): Promise<InstallFrameResult> {
  const res = await fetch(
    `/api/companies/${encodeURIComponent(companySlug)}/frames/install`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame }),
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`install failed (${res.status}): ${body}`)
  }
  const data = (await res.json()) as InstallFrameResult
  return { team: data.team, warnings: data.warnings ?? [] }
}

/** Convert the server-shaped team dict (snake_case) into the UI Team shape. */
export function teamFromInstallResult(t: Record<string, unknown>): Team {
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
      providerId: String(a.provider_id ?? ''),
      model: String(a.model ?? ''),
      systemPrompt: String(a.system_prompt ?? ''),
      skills: (a.skills as string[]) ?? [],
      position: (a.position as { x: number; y: number }) ?? { x: 0, y: 0 },
      maxParallel: Number(a.max_parallel ?? 1) || 1,
    })),
    edges: rawEdges.map((e) => ({
      id: String(e.id ?? ''),
      source: String(e.source ?? ''),
      target: String(e.target ?? ''),
    })),
    entryAgentId: (t.entry_agent_id as string | null) ?? null,
    allowedSkills: (t.allowed_skills as string[]) ?? [],
    limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
  }
}
