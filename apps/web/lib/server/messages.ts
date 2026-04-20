/**
 * Chat message persistence. Ports apps/server/openhive/persistence/messages.py.
 * Same `messages` table as the Python side.
 */

import { getDb } from './db'

export interface MessageRecord {
  id: string
  team_id: string
  from_id: string
  text: string
  run_id: string | null
  created_at: number
}

export function saveMessage(record: MessageRecord): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, team_id, from_id, text, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text`,
    )
    .run(
      record.id,
      record.team_id,
      record.from_id,
      record.text,
      record.run_id,
      record.created_at,
    )
}

export function listForTeam(teamId: string, limit = 500): MessageRecord[] {
  return getDb()
    .prepare(
      `SELECT id, team_id, from_id, text, run_id, created_at
         FROM messages
        WHERE team_id = ?
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(teamId, limit) as MessageRecord[]
}

export function clearTeam(teamId: string): number {
  const info = getDb()
    .prepare('DELETE FROM messages WHERE team_id = ?')
    .run(teamId)
  return info.changes
}

export function nowTs(): number {
  return Date.now()
}
