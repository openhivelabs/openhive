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

export interface RunEvent {
  kind: EventKind
  ts: number
  run_id: string
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
    })),
    edges: team.edges.map((e) => ({ source: e.source, target: e.target })),
  }
}

export async function* streamRun(
  team: Team,
  goal: string,
  signal?: AbortSignal,
): AsyncIterator<RunEvent> {
  const res = await fetch('/api/runs/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: toServerTeam(team), goal }),
    signal,
  })
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
        yield JSON.parse(payload) as RunEvent
      } catch {
        /* ignore malformed */
      }
    }
  }
}
