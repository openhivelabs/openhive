/**
 * Session persistence — FS-only. One folder per session under
 * ~/.openhive/sessions/{id}/:
 *
 *   meta.json         session metadata (id, task_id, team_id, goal, status, times)
 *   events.jsonl      append-only stream of every engine event (live during run)
 *   transcript.jsonl  distilled human-readable transcript (written on finalize)
 *   artifacts.json    metadata index for files under artifacts/
 *   artifacts/        generated files (PPTX, DOCX, PDF, etc.)
 *   usage.json        aggregated token usage for this session (written on finalize)
 *
 * No system DB. Engine emits events → appendSessionEvent → jsonl line. SSE fan-out
 * stays in-memory at the registry layer; on reconnect we replay from events.jsonl.
 *
 * Listing APIs scan meta.json files. At the current scale (hundreds of sessions)
 * this is instantaneous; introduce an in-memory index if it ever becomes hot.
 */
import fs from 'node:fs'
import path from 'node:path'

import { artifactsRoot, sessionsRoot } from './paths'

export interface SessionMeta {
  id: string
  task_id: string | null
  team_id: string
  goal: string
  status: 'running' | 'finished' | 'error' | 'interrupted'
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  artifact_count: number
}

/** Row shape returned by listing queries — same fields as meta plus any future
 *  columns. Kept as a separate alias for call-sites migrating off the SQL version. */
export type SessionRow = SessionMeta
export type SessionListRow = SessionMeta

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

// ---------- path helpers ----------

export function sessionDir(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId)
}
export function sessionArtifactDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'artifacts')
}
export function sessionMetaPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'meta.json')
}
export function sessionEventsPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'events.jsonl')
}
export function sessionTranscriptPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'transcript.jsonl')
}
export function sessionArtifactsIndexPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'artifacts.json')
}
export function sessionUsagePath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'usage.json')
}

// Back-compat alias — tools used to call this name.
export function artifactDirForSession(sessionId: string): string {
  return sessionArtifactDir(sessionId)
}

// ---------- meta read/write ----------

function readMeta(sessionId: string): SessionMeta | null {
  try {
    return JSON.parse(fs.readFileSync(sessionMetaPath(sessionId), 'utf8')) as SessionMeta
  } catch {
    return null
  }
}

function writeMeta(sessionId: string, meta: SessionMeta): void {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true })
  const tmp = `${sessionMetaPath(sessionId)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
  fs.renameSync(tmp, sessionMetaPath(sessionId))
}

function statusForMeta(status: string, error: string | null): SessionMeta['status'] {
  if (error === 'interrupted' || error === 'cancelled') return 'interrupted'
  if (status === 'running') return 'running'
  if (status === 'error') return 'error'
  return 'finished'
}

// ---------- lifecycle ----------

export function startSession(
  sessionId: string,
  teamId: string,
  goal: string,
  taskId: string | null = null,
): void {
  const now = Date.now()
  writeMeta(sessionId, {
    id: sessionId,
    task_id: taskId,
    team_id: teamId,
    goal,
    status: 'running',
    output: null,
    error: null,
    started_at: now,
    finished_at: null,
    artifact_count: 0,
  })
  // Touch events.jsonl so tail-style readers don't ENOENT.
  fs.closeSync(fs.openSync(sessionEventsPath(sessionId), 'a'))
}

export function finishSession(
  sessionId: string,
  opts: { output?: string | null; error?: string | null } = {},
): void {
  finalizeSession(sessionId, opts)
}

/** Writes transcript.jsonl + updates meta.json with final status. Safe to call
 *  multiple times (last one wins). */
export function finalizeSession(
  sessionId: string,
  opts: { output?: string | null; error?: string | null } = {},
): void {
  const meta = readMeta(sessionId)
  if (!meta) return

  const events = eventsForSession(sessionId)
  const lines = buildTranscript(meta.goal, meta.started_at, events)
  fs.writeFileSync(
    sessionTranscriptPath(sessionId),
    `${lines.map((t) => JSON.stringify(t)).join('\n')}\n`,
    'utf8',
  )

  const artDir = sessionArtifactDir(sessionId)
  if (fs.existsSync(artDir) && fs.readdirSync(artDir).length === 0) {
    try { fs.rmdirSync(artDir) } catch { /* ignore */ }
  }
  const artifactCount = fs.existsSync(artDir) ? fs.readdirSync(artDir).length : 0

  const prevStatus = meta.status === 'running'
    ? (opts.error ? 'error' : 'finished')
    : meta.status

  writeMeta(sessionId, {
    ...meta,
    status: statusForMeta(prevStatus, opts.error ?? meta.error),
    output: opts.output ?? meta.output,
    error: opts.error ?? meta.error,
    finished_at: meta.finished_at ?? Date.now(),
    artifact_count: artifactCount,
  })
}

// ---------- events ----------

export function appendSessionEvent(input: AppendEventInput): void {
  fs.mkdirSync(sessionDir(input.sessionId), { recursive: true })
  const row = {
    seq: input.seq,
    ts: input.ts,
    kind: input.kind,
    depth: input.depth,
    node_id: input.nodeId,
    tool_call_id: input.toolCallId,
    tool_name: input.toolName,
    data_json: JSON.stringify(input.data),
  }
  fs.appendFileSync(sessionEventsPath(input.sessionId), `${JSON.stringify(row)}\n`, 'utf8')
}

export function eventsForSession(sessionId: string): StoredEventRow[] {
  const p = sessionEventsPath(sessionId)
  if (!fs.existsSync(p)) return []
  const text = fs.readFileSync(p, 'utf8')
  const out: StoredEventRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as {
        seq: number; ts: number; kind: string; depth: number;
        node_id: string | null; tool_call_id: string | null;
        tool_name: string | null; data_json?: string;
        data?: Record<string, unknown>;
      }
      out.push({
        seq: row.seq,
        ts: row.ts,
        kind: row.kind,
        depth: row.depth,
        node_id: row.node_id,
        tool_call_id: row.tool_call_id,
        tool_name: row.tool_name,
        data: row.data ?? (row.data_json ? JSON.parse(row.data_json) as Record<string, unknown> : {}),
      })
    } catch {
      // Truncated last line after crash — skip it, don't fail the whole session.
    }
  }
  return out
}

// ---------- listing ----------

function listSessionIds(): string[] {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}

function readAllMeta(): SessionMeta[] {
  const out: SessionMeta[] = []
  for (const id of listSessionIds()) {
    const m = readMeta(id)
    if (m) out.push(m)
  }
  return out
}

export function listSessions(limit = 100): SessionMeta[] {
  const metas = readAllMeta().sort((a, b) => b.started_at - a.started_at)
  return metas.slice(0, limit)
}

export function listForTeam(teamId: string, limit = 50): SessionRow[] {
  return readAllMeta()
    .filter((m) => m.team_id === teamId)
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, limit)
}

export function getSession(sessionId: string): SessionMeta | null {
  return readMeta(sessionId)
}

export function listSessionsFor(opts: {
  teamId?: string | null
  taskId?: string | null
  limit?: number
}): SessionListRow[] {
  const { teamId = null, taskId = null, limit = 200 } = opts
  let metas = readAllMeta()
  if (teamId) metas = metas.filter((m) => m.team_id === teamId)
  if (taskId) metas = metas.filter((m) => m.task_id === taskId)
  metas.sort((a, b) => b.started_at - a.started_at)
  const lim = Number.isFinite(limit) ? (limit as number) : 200
  return metas.slice(0, lim)
}

/** Any session whose meta.json still says status='running' on boot was in flight
 *  when the process died. Mark them interrupted and finalize transcript. */
export function markOrphanedSessionsInterrupted(): number {
  let n = 0
  for (const id of listSessionIds()) {
    const meta = readMeta(id)
    if (!meta || meta.status !== 'running') continue
    finalizeSession(id, { error: 'interrupted' })
    n += 1
  }
  return n
}

/** Regenerate transcript.jsonl for any already-finished session that lacks
 *  one (e.g. historical rows migrated from the legacy DB that were finalised
 *  before transcripts were being written to disk). Reads events.jsonl →
 *  distills → writes transcript.jsonl. Idempotent: sessions with an existing
 *  transcript are skipped. */
export function backfillTranscripts(): number {
  let n = 0
  for (const id of listSessionIds()) {
    const tPath = sessionTranscriptPath(id)
    if (fs.existsSync(tPath)) continue
    const meta = readMeta(id)
    if (!meta) continue
    const events = eventsForSession(id)
    if (events.length === 0) continue
    const lines = buildTranscript(meta.goal, meta.started_at, events)
    fs.writeFileSync(tPath, `${lines.map((t) => JSON.stringify(t)).join('\n')}\n`, 'utf8')
    n += 1
  }
  return n
}

// ---------- transcript helper ----------

export function buildTranscript(
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
    } else if (ev.kind === 'user_message') {
      // Follow-up user message in an ongoing chat session.
      lines.push({ kind: 'user_message', ts: ev.ts, text: ev.data.text })
    } else if (ev.kind === 'tool_called' && ev.depth === 0) {
      // Only Lead-level tool calls make it into the chat. Sub-agent tool
      // calls live in events.jsonl for the thinking-process view.
      lines.push({
        kind: 'tool_call',
        ts: ev.ts,
        node_id: ev.node_id,
        tool: ev.tool_name,
        args: ev.data.arguments,
      })
    } else if (ev.kind === 'node_finished' && ev.depth === 0) {
      // Only Lead (depth=0) turns surface as assistant messages in the chat.
      // Sub-agent node_finished events still live in events.jsonl and will be
      // rendered as a separate "thinking process" view later.
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

// ---------- legacy artifacts root cleanup ----------

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
        try { fs.unlinkSync(abs) } catch { /* ignore */ }
      } else {
        allEmpty = false
      }
    }
    if (allEmpty && dir !== root) {
      try { fs.rmdirSync(dir) } catch { /* ignore */ }
    }
    return allEmpty
  }
  if (walk(root)) {
    try { fs.rmdirSync(root) } catch { /* ignore */ }
  }
}

export function pruneLegacyArtifactsRoot(): void {
  pruneEmptyTree(artifactsRoot())
}
