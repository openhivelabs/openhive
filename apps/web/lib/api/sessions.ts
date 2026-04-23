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
  payload: {
    answers?: Record<string, string>
    skipped?: boolean
    sessionId?: string
    locale?: string
  },
): Promise<void> {
  const res = await fetch('/api/sessions/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool_call_id: toolCallId,
      session_id: payload.sessionId ?? null,
      locale: payload.locale ?? null,
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

export async function startSession(
  team: Team,
  goal: string,
  options?: { locale?: string; taskId?: string },
): Promise<{ sessionId: string }> {
  const res = await fetch('/api/sessions/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      team_id: team.id,
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

/** Mutate session metadata (title / pinned). Silently fails on network error —
 *  callers do optimistic local updates and don't roll back on server failure.
 *  (A user who can't reach their own local server has bigger problems.) */
export async function patchSession(
  sessionId: string,
  patch: { title?: string | null; pinned?: boolean; viewed?: boolean },
): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  } catch {
    /* local-first: swallow */
  }
}

export async function deleteSessionRequest(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  } catch {
    /* best-effort */
  }
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
      team_id: team.id,
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
