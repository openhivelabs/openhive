import type { Message } from '@/lib/types'

interface ServerMessage {
  id: string
  team_id: string
  from_id: string
  text: string
  session_id: string | null
  created_at: number
}

function fromServer(m: ServerMessage): Message {
  return {
    id: m.id,
    teamId: m.team_id,
    from: m.from_id,
    text: m.text,
    createdAt: new Date(m.created_at).toISOString(),
  }
}

export async function listMessages(teamId: string): Promise<Message[]> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/messages`)
  if (!res.ok) throw new Error(`GET messages ${res.status}`)
  const data = (await res.json()) as ServerMessage[]
  return data.map(fromServer)
}

export async function appendMessage(message: Message, sessionId?: string): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(message.teamId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: message.id,
      from_id: message.from,
      text: message.text,
      session_id: sessionId ?? null,
      created_at: Date.parse(message.createdAt) || Date.now(),
    }),
  })
  if (!res.ok) throw new Error(`POST message ${res.status}`)
}

export async function clearMessages(teamId: string): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/messages`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`DELETE messages ${res.status}`)
}
