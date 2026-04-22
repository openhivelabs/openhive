import type { Team } from '@/lib/types'

export type EventKind =
  | 'run_started'
  | 'run_finished'
  | 'run_error'
  | 'node_started'
  | 'node_finished'
  | 'token'
  | 'tool_called'
  | 'tool_result'
  | 'delegation_opened'
  | 'delegation_closed'
  | 'checkpoint'
  | 'user_question'
  | 'user_answered'
  | 'turn_finished'
  | 'user_message'

export interface AskUserOption {
  label: string
  description: string
}

export interface AskUserQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: AskUserOption[]
}

export async function postAnswer(
  toolCallId: string,
  payload: { answers?: Record<string, string>; skipped?: boolean },
): Promise<void> {
  const res = await fetch('/api/sessions/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool_call_id: toolCallId,
      answers: payload.answers ?? null,
      skipped: payload.skipped ?? false,
    }),
  })
  if (!res.ok) {
    throw new Error(`answer failed (${res.status}): ${await res.text()}`)
  }
}

export interface SessionEvent {
  kind: EventKind
  ts: number
  session_id: string
  depth: number
  node_id: string | null
  tool_call_id: string | null
  tool_name: string | null
  data: Record<string, unknown>
}

/** Convert the UI's Team (with camelCase fields) into the server's TeamSpec shape. */
function toServerTeam(team: Team) {
  return {
    id: team.id,
    name: team.name,
    agents: team.agents.map((a) => ({
      id: a.id,
      role: a.role,
      label: a.label,
      provider_id: a.providerId,
      model: a.model,
      system_prompt: a.systemPrompt,
      skills: a.skills,
      max_parallel: a.maxParallel ?? 1,
    })),
    edges: team.edges.map((e) => ({ source: e.source, target: e.target })),
    entry_agent_id: team.entryAgentId ?? null,
    allowed_skills: team.allowedSkills ?? [],
    allowed_mcp_servers: team.allowedMcpServers ?? [],
    limits: team.limits ?? { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
  }
}

export async function startSession(
  team: Team,
  goal: string,
  options?: { locale?: string; taskId?: string },
): Promise<{ sessionId: string }> {
  const res = await fetch('/api/sessions/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      team: toServerTeam(team),
      goal,
      locale: options?.locale ?? 'en',
      task_id: options?.taskId,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`run start failed (${res.status}): ${body}`)
  }
  const data = (await res.json()) as { session_id: string }
  return { sessionId: data.session_id }
}

export async function stopBackendSession(sessionId: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' })
}

/** Attach to an already-running (or finished) run by id. Replays persisted
 *  events then tails live ones until the server emits [DONE]. Safe to call
 *  again after a page reload — the backend run keeps going without us. */
export async function* attachSession(
  sessionId: string,
  options?: { signal?: AbortSignal },
): AsyncGenerator<SessionEvent> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, {
    method: 'GET',
    signal: options?.signal,
  })
  yield* readSseStream(res)
}

export async function* streamSession(
  team: Team,
  goal: string,
  options?: { locale?: string; signal?: AbortSignal },
): AsyncGenerator<SessionEvent> {
  const res = await fetch('/api/sessions/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      team: toServerTeam(team),
      goal,
      locale: options?.locale ?? 'en',
    }),
    signal: options?.signal,
  })
  yield* readSseStream(res)
}

async function* readSseStream(res: Response): AsyncGenerator<SessionEvent> {
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`run stream failed (${res.status}): ${body}`)
  }
  if (!res.body) throw new Error('no response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      if (!frame.startsWith('data: ')) continue
      const payload = frame.slice(6).trim()
      if (payload === '[DONE]') return
      try {
        yield JSON.parse(payload) as SessionEvent
      } catch {
        /* ignore malformed */
      }
    }
  }
}
