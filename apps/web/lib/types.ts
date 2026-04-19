export type ProviderKind = 'oauth' | 'api_key' | 'local'

export interface Provider {
  id: string
  kind: ProviderKind
  label: string
  connected: boolean
}

export interface Agent {
  id: string
  role: string
  label: string
  providerId: string
  model: string
  systemPrompt: string
  skills: string[]
  position: { x: number; y: number }
  isActive?: boolean
}

export interface ReportingEdge {
  id: string
  source: string
  target: string
  isActive?: boolean
}

export interface Team {
  id: string
  slug: string
  name: string
  agents: Agent[]
  edges: ReportingEdge[]
}

export interface Company {
  id: string
  slug: string
  name: string
  teams: Team[]
}

export interface Message {
  id: string
  teamId: string
  from: 'user' | string
  to?: string
  text: string
  createdAt: string
}

export type TriggerKind = 'chat' | 'cron' | 'webhook' | 'file_watch' | 'manual'

export interface Trigger {
  id: string
  kind: TriggerKind
  teamId: string
  label: string
  config: Record<string, unknown>
  enabled: boolean
}

export interface Artifact {
  id: string
  teamId: string
  runId: string
  filename: string
  path: string
  mime: string
  createdAt: string
}

export type CanvasMode = 'design' | 'run'
export type DrawerTab = 'chat' | 'triggers' | 'artifacts'
