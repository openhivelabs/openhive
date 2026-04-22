import yaml from 'js-yaml'
import type { Agent } from '@/lib/types'

export interface AgentFrameRequires {
  skills: string[]
  providers: string[]
}

export interface AgentGalleryEntry {
  id: string
  name: string
  description: string
  version: string
  tags: string[]
  role: string
  provider_id: string
  model: string
  has_persona: boolean
  requires: AgentFrameRequires
  frame: unknown
}

export interface AgentFramePreview {
  raw: unknown
  name: string
  description: string
  version: string
  role: string
  providerId: string
  model: string
  hasPersona: boolean
  requires: AgentFrameRequires
}

/** Parse an agent-frame YAML file in the browser and surface a preview. */
export async function parseAgentFrameFile(file: File): Promise<AgentFramePreview> {
  const text = await file.text()
  let raw: unknown
  try {
    raw = yaml.load(text)
  } catch (e) {
    throw new Error(`Could not parse YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Agent frame file is empty or malformed.')
  }
  const r = raw as Record<string, unknown>
  if (r.openhive_agent_frame !== 1) {
    throw new Error(
      `Unsupported agent frame version: ${String(r.openhive_agent_frame)}. This hive expects version 1.`,
    )
  }
  const agent = (r.agent as Record<string, unknown>) || {}
  const requires = (r.requires as Record<string, unknown>) || {}
  const assets = (r.persona_assets as Record<string, unknown>) || {}
  return {
    raw,
    name: String(r.name ?? agent.role ?? agent.label ?? 'Untitled agent'),
    description: String(r.description ?? ''),
    version: String(r.version ?? '1.0.0'),
    role: String(agent.role ?? ''),
    providerId: String(agent.provider_id ?? ''),
    model: String(agent.model ?? ''),
    hasPersona: Object.keys(assets).length > 0,
    requires: {
      skills: Array.isArray(requires.skills) ? (requires.skills as string[]) : [],
      providers: Array.isArray(requires.providers) ? (requires.providers as string[]) : [],
    },
  }
}

export async function listAgentGallery(): Promise<AgentGalleryEntry[]> {
  const res = await fetch('/api/agent-frames/gallery')
  if (!res.ok) throw new Error(`GET /api/agent-frames/gallery ${res.status}`)
  return (await res.json()) as AgentGalleryEntry[]
}

export interface InstallAgentFrameResult {
  agent: Record<string, unknown>
  warnings: string[]
}

export async function installAgentFrame(
  companySlug: string,
  teamSlug: string,
  frame: unknown,
): Promise<InstallAgentFrameResult> {
  const res = await fetch(
    `/api/companies/${encodeURIComponent(companySlug)}/teams/${encodeURIComponent(teamSlug)}/agents/install`,
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
  const data = (await res.json()) as InstallAgentFrameResult
  return { agent: data.agent, warnings: data.warnings ?? [] }
}

/** Map the server-shaped agent dict (snake_case) into the UI Agent shape. */
export function agentFromInstallResult(a: Record<string, unknown>): Agent {
  return {
    id: String(a.id ?? ''),
    role: String(a.role ?? ''),
    label: String(a.label ?? ''),
    providerId: String(a.provider_id ?? ''),
    model: String(a.model ?? ''),
    systemPrompt: String(a.system_prompt ?? ''),
    skills: (a.skills as string[]) ?? [],
    position: (a.position as { x: number; y: number }) ?? { x: 0, y: 0 },
    maxParallel: Number(a.max_parallel ?? 1) || 1,
  }
}

/** Trigger a download of an agent as an .openhive-agent-frame.yaml file. */
export function downloadAgentFrame(
  companySlug: string,
  teamSlug: string,
  agentId: string,
): void {
  const url =
    `/api/companies/${encodeURIComponent(companySlug)}/teams/${encodeURIComponent(teamSlug)}` +
    `/agents/${encodeURIComponent(agentId)}/frame`
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
