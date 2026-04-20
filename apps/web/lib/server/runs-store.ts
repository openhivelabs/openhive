/**
 * Run + run_events persistence. Every engine event is appended here so the
 * Timeline UI can replay any past run offline (SQLite = source of truth).
 * Ports apps/server/openhive/persistence/runs.py.
 */

import { getDb } from './db'

export interface RunRow {
  id: string
  team_id: string
  goal: string
  status: string
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
}

export interface StoredEventRow {
  seq: number
  ts: number
  kind: string
  depth: number
  node_id: string | null
  tool_call_id: string | null
  tool_name: string | null
  data: Record<string, unknown>
}

export function startRun(runId: string, teamId: string, goal: string): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO runs (id, team_id, goal, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    )
    .run(runId, teamId, goal, now)
}

export function finishRun(
  runId: string,
  opts: { output?: string | null; error?: string | null } = {},
): void {
  const now = Date.now()
  const status = opts.error ? 'error' : 'finished'
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, output = ?, error = ?, finished_at = ?
        WHERE id = ?`,
    )
    .run(status, opts.output ?? null, opts.error ?? null, now, runId)
}

export interface AppendEventInput {
  runId: string
  seq: number
  ts: number
  kind: string
  depth: number
  nodeId: string | null
  toolCallId: string | null
  toolName: string | null
  data: Record<string, unknown>
}

export function appendRunEvent(input: AppendEventInput): void {
  getDb()
    .prepare(
      `INSERT INTO run_events
        (run_id, seq, ts, kind, depth, node_id, tool_call_id, tool_name, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.seq,
      input.ts,
      input.kind,
      input.depth,
      input.nodeId,
      input.toolCallId,
      input.toolName,
      JSON.stringify(input.data),
    )
}

export function listForTeam(teamId: string, limit = 50): RunRow[] {
  return getDb()
    .prepare(
      `SELECT id, team_id, goal, status, output, error, started_at, finished_at
         FROM runs WHERE team_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(teamId, limit) as RunRow[]
}

export function eventsFor(runId: string): StoredEventRow[] {
  const rows = getDb()
    .prepare(
      `SELECT seq, ts, kind, depth, node_id, tool_call_id, tool_name, data_json
         FROM run_events WHERE run_id = ? ORDER BY seq ASC`,
    )
    .all(runId) as (Omit<StoredEventRow, 'data'> & { data_json: string | null })[]
  return rows.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    kind: r.kind,
    depth: r.depth,
    node_id: r.node_id,
    tool_call_id: r.tool_call_id,
    tool_name: r.tool_name,
    data: r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : {},
  }))
}

/** Boot-time cleanup: runs that were still "running" when the server died
 *  must be marked interrupted so the UI doesn't show zombie active runs. */
export function markOrphanedRunsInterrupted(): number {
  const info = getDb()
    .prepare(
      `UPDATE runs SET status = 'error', error = 'interrupted', finished_at = ?
        WHERE status = 'running'`,
    )
    .run(Date.now())
  return info.changes
}
