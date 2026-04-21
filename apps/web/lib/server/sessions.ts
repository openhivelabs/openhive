/**
 * Session persistence. A session is the single canonical execution record.
 * Events are persisted to SQLite and mirrored to ~/.openhive/sessions/{id}/
 * for transcript/debug artifacts.
 */
import fs from 'node:fs'
import path from 'node:path'

import { getDb } from './db'
import { artifactsRoot, sessionsRoot } from './paths'

export interface SessionRow {
  id: string
  task_id: string | null
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

export interface SessionMeta {
  id: string
  team_id: string | null
  goal: string
  status: 'running' | 'finished' | 'error' | 'interrupted'
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  artifact_count: number
}

export interface SessionListRow {
  id: string
  team_id: string
  task_id: string | null
  goal: string
  status: string
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
}

export function sessionDir(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId)
}

export function sessionArtifactDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'artifacts')
}

export function sessionMetaPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'meta.json')
}

function readMeta(sessionId: string): SessionMeta | null {
  try {
    return JSON.parse(fs.readFileSync(sessionMetaPath(sessionId), 'utf8')) as SessionMeta
  } catch {
    return null
  }
}

function writeMeta(sessionId: string, meta: SessionMeta): void {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true })
  fs.writeFileSync(sessionMetaPath(sessionId), JSON.stringify(meta, null, 2), 'utf8')
}

function statusForMeta(status: string, error: string | null): SessionMeta['status'] {
  if (error === 'interrupted' || error === 'cancelled') return 'interrupted'
  if (status === 'running') return 'running'
  if (status === 'error') return 'error'
  return 'finished'
}

export function startSession(
  sessionId: string,
  teamId: string,
  goal: string,
  taskId: string | null = null,
): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sessions
        (id, task_id, team_id, goal, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
    )
    .run(sessionId, taskId, teamId, goal, now)
  writeMeta(sessionId, {
    id: sessionId,
    team_id: teamId,
    goal,
    status: 'running',
    output: null,
    error: null,
    started_at: now,
    finished_at: null,
    artifact_count: 0,
  })
}

export function finishSession(
  sessionId: string,
  opts: { output?: string | null; error?: string | null } = {},
): void {
  const now = Date.now()
  const status = opts.error ? 'error' : 'finished'
  getDb()
    .prepare(
      `UPDATE sessions SET status = ?, output = ?, error = ?, finished_at = ?
        WHERE id = ?`,
    )
    .run(status, opts.output ?? null, opts.error ?? null, now, sessionId)
  finalizeSession(sessionId, opts)
}

export interface AppendEventInput {
  sessionId: string
  seq: number
  ts: number
  kind: string
  depth: number
  nodeId: string | null
  toolCallId: string | null
  toolName: string | null
  data: Record<string, unknown>
}

export function appendSessionEvent(input: AppendEventInput): void {
  getDb()
    .prepare(
      `INSERT INTO session_events
        (session_id, seq, ts, kind, depth, node_id, tool_call_id, tool_name, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
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

export function listForTeam(teamId: string, limit = 50): SessionRow[] {
  return getDb()
    .prepare(
      `SELECT id, task_id, team_id, goal, status, output, error, started_at, finished_at
         FROM sessions WHERE team_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(teamId, limit) as SessionRow[]
}

export function eventsForSession(sessionId: string): StoredEventRow[] {
  const rows = getDb()
    .prepare(
      `SELECT seq, ts, kind, depth, node_id, tool_call_id, tool_name, data_json
         FROM session_events WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as (Omit<StoredEventRow, 'data'> & { data_json: string | null })[]
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

export function markOrphanedSessionsInterrupted(): number {
  const now = Date.now()
  const rows = getDb()
    .prepare("SELECT id FROM sessions WHERE status = 'running'")
    .all() as { id: string }[]
  const info = getDb()
    .prepare(
      `UPDATE sessions SET status = 'error', error = 'interrupted', finished_at = ?
        WHERE status = 'running'`,
    )
    .run(now)
  for (const row of rows) finalizeSession(row.id, { error: 'interrupted' })
  return info.changes
}

export function artifactDirForSession(sessionId: string): string {
  return sessionArtifactDir(sessionId)
}

function buildTranscript(
  goal: string,
  startedAt: number,
  events: StoredEventRow[],
): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [{ kind: 'goal', text: goal, ts: startedAt / 1000 }]
  for (const ev of events) {
    if (ev.kind === 'user_question') {
      lines.push({
        kind: 'ask_user',
        ts: ev.ts,
        agent_role: ev.data.agent_role,
        questions: ev.data.questions,
      })
    } else if (ev.kind === 'user_answered') {
      lines.push({ kind: 'user_answer', ts: ev.ts, result: ev.data.result })
    } else if (ev.kind === 'tool_called') {
      lines.push({
        kind: 'tool_call',
        ts: ev.ts,
        node_id: ev.node_id,
        tool: ev.tool_name,
        args: ev.data.arguments,
      })
    } else if (ev.kind === 'node_finished') {
      const output = ev.data.output
      if (typeof output === 'string' && output.trim()) {
        lines.push({
          kind: 'agent_message',
          ts: ev.ts,
          node_id: ev.node_id,
          text: output,
        })
      }
    }
  }
  return lines
}

function writeTranscriptAndEvents(
  sessionId: string,
  goal: string,
  startedAt: number,
  events: StoredEventRow[],
): void {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true })
  if (events.length > 0) {
    fs.writeFileSync(
      path.join(sessionDir(sessionId), 'events.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    )
  }
  const lines = buildTranscript(goal, startedAt, events)
  fs.writeFileSync(
    path.join(sessionDir(sessionId), 'transcript.jsonl'),
    `${lines.map((t) => JSON.stringify(t)).join('\n')}\n`,
    'utf8',
  )
}

export function finalizeSession(
  sessionId: string,
  opts: { output?: string | null; error?: string | null } = {},
): void {
  const row = getDb()
    .prepare(
      `SELECT id, task_id, team_id, goal, status, output, error, started_at, finished_at
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined
  if (!row) return

  const events = eventsForSession(sessionId)
  writeTranscriptAndEvents(sessionId, row.goal, row.started_at, events)

  const artDir = sessionArtifactDir(sessionId)
  if (fs.existsSync(artDir) && fs.readdirSync(artDir).length === 0) fs.rmdirSync(artDir)
  const artifactCount = fs.existsSync(artDir) ? fs.readdirSync(artDir).length : 0

  writeMeta(sessionId, {
    id: sessionId,
    team_id: row.team_id,
    goal: row.goal,
    status: statusForMeta(opts.error ? 'error' : row.status, opts.error ?? row.error),
    output: opts.output ?? row.output,
    error: opts.error ?? row.error,
    started_at: row.started_at,
    finished_at: row.finished_at ?? Date.now(),
    artifact_count: artifactCount,
  })
}

export function listSessions(limit = 100): SessionMeta[] {
  const rows = getDb()
    .prepare(
      `SELECT id, task_id, team_id, goal, status, output, error, started_at, finished_at
         FROM sessions ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as SessionRow[]
  return rows.map((row) => ({
    id: row.id,
    team_id: row.team_id,
    goal: row.goal,
    status: statusForMeta(row.status, row.error),
    output: row.output,
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
    artifact_count: 0,
  }))
}

export function getSession(sessionId: string): SessionMeta | null {
  const meta = readMeta(sessionId)
  if (meta) return meta
  const row = getDb()
    .prepare(
      `SELECT id, task_id, team_id, goal, status, output, error, started_at, finished_at
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined
  if (!row) return null
  return {
    id: row.id,
    team_id: row.team_id,
    goal: row.goal,
    status: statusForMeta(row.status, row.error),
    output: row.output,
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
    artifact_count: 0,
  }
}

export function listSessionsFor(opts: {
  teamId?: string | null
  taskId?: string | null
  limit?: number
}): SessionListRow[] {
  const { teamId = null, taskId = null, limit = 200 } = opts
  const where: string[] = []
  const args: unknown[] = []
  if (teamId) {
    where.push('team_id = ?')
    args.push(teamId)
  }
  if (taskId) {
    where.push('task_id = ?')
    args.push(taskId)
  }
  const sqlWhere = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  return getDb()
    .prepare(
      `SELECT id, team_id, task_id, goal, status, output, error, started_at, finished_at
         FROM sessions
        ${sqlWhere}
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(...args, Number.isFinite(limit) ? limit : 200) as SessionListRow[]
}

const JUNK_FILENAMES = new Set(['.DS_Store', 'Thumbs.db', '.localized'])

function pruneEmptyTree(root: string): void {
  if (!fs.existsSync(root)) return
  const walk = (dir: string): boolean => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    let allEmpty = true
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!walk(abs)) allEmpty = false
      } else if (JUNK_FILENAMES.has(e.name)) {
        try { fs.unlinkSync(abs) } catch {}
      } else {
        allEmpty = false
      }
    }
    if (allEmpty && dir !== root) {
      try { fs.rmdirSync(dir) } catch {}
    }
    return allEmpty
  }
  if (walk(root)) {
    try { fs.rmdirSync(root) } catch {}
  }
}

export function pruneLegacyArtifactsRoot(): void {
  pruneEmptyTree(artifactsRoot())
}
