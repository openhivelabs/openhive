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
  /** Max parallel instances of this agent. Default 1 (serial). Capped at 100.
   *  Forced to 1 for the team's Lead regardless of value. */
  maxParallel?: number
}

export interface ReportingEdge {
  id: string
  source: string
  target: string
  isActive?: boolean
}

export interface RunLimits {
  max_tool_rounds_per_turn: number
  max_delegation_depth: number
}

export interface Team {
  id: string
  slug: string
  name: string
  /** 사이드바에 표시되는 팀 아이콘 이름 (phosphor 아이콘 이름 문자열).
   *  값 없으면 기본 'Users' 로 렌더. */
  icon?: string
  agents: Agent[]
  edges: ReportingEdge[]
  entryAgentId?: string | null
  allowedSkills?: string[]
  /** MCP server names whose tools (`<server>__<tool>`) get exposed to this team's agents. */
  allowedMcpServers?: string[]
  limits?: RunLimits
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
  sessionId: string
  filename: string
  path: string
  mime: string
  createdAt: string
}

export type CanvasMode = 'design' | 'run'
export type DrawerTab = 'chat' | 'data' | 'triggers' | 'artifacts'

export type TaskMode = 'now' | 'scheduled'
export type SessionStatus = 'running' | 'needs_input' | 'done' | 'failed'

export interface PendingAsk {
  toolCallId: string
  questions: unknown[]
  agentRole?: string
}

/** Session = 실행 레코드. Task와 분리된 1급 엔티티 — task는 템플릿, 세션은
 *  거기서 spawn된 독립 실행. `taskId`는 역참조용 optional FK. */
export interface Session {
  /** Permanent backend session id. Single source of truth for URL + client state. */
  id: string
  /** Local optimistic id used before the backend session id is known. */
  clientSessionId?: string
  /** Optional: task template this was spawned from. Null for ad-hoc sessions. */
  taskId: string | null
  teamId: string
  goal: string
  status: SessionStatus
  /** ISO timestamps. */
  startedAt: string
  endedAt?: string
  error?: string
  pendingAsk?: PendingAsk
  /** Streaming agent bubbles (session canvas, chat). `from` = agent id or 'system'. */
  messages: Message[]
  /** Set the first time the user opened the finished session. Drives unread dot. */
  viewedAt?: string
  /** User-renamed display title. When unset, UI falls back to goal slice or
   *  the server-generated auto-title. */
  title?: string | null
  /** User-pinned sessions sort to the top of the inbox. */
  pinned?: boolean
}

export interface TaskReference {
  id: string
  name: string
  size: number
  kind: 'text' | 'binary'
  /** Inline text contents for text kind. Trimmed to MAX_INLINE_BYTES on load. */
  content?: string
  /** Optional user comment describing how to use this file. Prepended to the file block in the composed prompt. */
  note?: string
}

export interface Task {
  id: string
  teamId: string
  title: string
  prompt: string
  mode: TaskMode
  /** cron expression when mode === 'scheduled' */
  cron?: string
  createdAt: string
  sessions: Session[]
  /** Reference materials the Lead should ground the task in (files, snippets). */
  references: TaskReference[]
}
