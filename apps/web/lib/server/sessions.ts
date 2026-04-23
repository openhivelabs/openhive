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
import type { TeamSpec } from './engine/team'

import { artifactsRoot, sessionsRoot } from './paths'
import { enqueueEvent, flushSession } from './sessions/event-writer'

/** Session status — lives independently of any single Node process.
 *    running      = a turn is currently being generated (live tokens flowing)
 *    needs_input  = parked on an unanswered ask_user question. The engine
 *                   literally cannot proceed until the user answers (or skips).
 *                   Distinct from `idle` because the UI must keep surfacing
 *                   this as a pending action — otherwise the user navigates
 *                   away, the orange dot disappears on their next visit, and
 *                   the session sits forever waiting.
 *    idle         = turn done, waiting for the next user message. Resumable.
 *    error        = errored out in a way we don't auto-recover from.
 *
 *  Notes:
 *  - "Process died while mid-turn" is NOT a status. On boot we demote
 *    `running` → `idle`; the next user message resurrects the generator via
 *    resume(). Old values ('finished', 'interrupted') still on disk from
 *    before this redesign are normalized to `idle` on read — sessions are
 *    always resumable unless the user explicitly deleted them. */
export type SessionStatus = 'running' | 'needs_input' | 'idle' | 'error'

export interface SessionMeta {
  id: string
  task_id: string | null
  team_id: string
  goal: string
  status: SessionStatus
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  artifact_count: number
  /** Optional human-friendly title generated asynchronously from the goal,
   *  or set manually via rename. null/undefined = "not set" — UI falls back
   *  to goal slice. */
  title?: string | null
  /** User-pinned sessions sort to the top of the inbox. Persisted so it
   *  survives reload / device switch. */
  pinned?: boolean
  /** TeamSpec at session-start time. Needed on resume to reconstruct the
   *  engine state for a follow-up message after the original process died.
   *  Optional on the type so legacy sessions (pre-resume-refactor) still
   *  load — those can't be resumed but don't break listing. */
  team_snapshot?: TeamSpec
  /** Timestamp of the first successful `finalizeSession` call. Used as an
   *  idempotent guard so the A2 Stop-hook path in `runTeamBody` and the
   *  registry-level finalize can both call safely — only the first writes
   *  transcript / usage. */
  finalized_at?: number | null
}

function normalizeStatus(raw: unknown): SessionStatus {
  if (raw === 'running') return 'running'
  if (raw === 'needs_input') return 'needs_input'
  if (raw === 'error') return 'error'
  // 'finished', 'interrupted', and anything unknown collapse to idle. Idle
  // means "no live generator right now — send a message to continue."
  return 'idle'
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
    const raw = JSON.parse(fs.readFileSync(sessionMetaPath(sessionId), 'utf8')) as SessionMeta
    // Coerce legacy statuses ('finished', 'interrupted') into the new 3-value
    // enum. This is a pure read-time remap; on-disk file is left alone until
    // something writes it back via updateMeta/writeMeta.
    return { ...raw, status: normalizeStatus(raw.status) }
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

/** Partially update a session's meta.json. Silently no-ops if the session
 *  folder is gone (e.g. deleted mid-run). Used by async enrichers like the
 *  auto-title generator. */
export function updateMeta(
  sessionId: string,
  patch: Partial<SessionMeta>,
): SessionMeta | null {
  const current = readMeta(sessionId)
  if (!current) return null
  const next: SessionMeta = { ...current, ...patch, id: current.id }
  writeMeta(sessionId, next)
  return next
}

/** Convenience wrapper — used by driveSession's fire-and-forget title job. */
export function updateMetaTitle(sessionId: string, title: string | null): void {
  if (!title) return
  try {
    updateMeta(sessionId, { title })
  } catch {
    /* swallow — title is best-effort */
  }
}

function statusForMeta(status: string, error: string | null): SessionMeta['status'] {
  if (status === 'running') return 'running'
  if (status === 'error' || (error && error !== 'interrupted' && error !== 'cancelled')) {
    return 'error'
  }
  // 'interrupted' / 'cancelled' are no longer terminal — the session is just
  // parked without a live generator and becomes resumable via the messages
  // endpoint. Everything that isn't actively running or hard-errored is idle.
  return 'idle'
}

// ---------- lifecycle ----------

export function startSession(
  sessionId: string,
  teamId: string,
  goal: string,
  taskId: string | null = null,
  teamSnapshot: TeamSpec | null = null,
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
    // Snapshot the team spec so follow-up messages can resume this session
    // after the original process died, without the client having to re-POST
    // the whole team structure.
    team_snapshot: teamSnapshot ?? undefined,
  })
  // Touch events.jsonl so tail-style readers don't ENOENT.
  fs.closeSync(fs.openSync(sessionEventsPath(sessionId), 'a'))
}

export async function finishSession(
  sessionId: string,
  opts: { output?: string | null; error?: string | null } = {},
): Promise<void> {
  await finalizeSession(sessionId, opts)
}

/** Writes transcript.jsonl + updates meta.json with final status. Safe to call
 *  multiple times (last one wins). Awaits the per-session event flusher so
 *  no buffered events are lost when the transcript is built. */
export async function finalizeSession(
  sessionId: string,
  opts: { output?: string | null; error?: string | null } = {},
): Promise<void> {
  // A2 idempotency guard: `runTeamBody`'s finally and the run-registry both
  // call this — only the first invocation writes transcript/usage/meta.
  // Subsequent calls are cheap no-ops so Stop hooks can fire exactly once.
  const existing = readMeta(sessionId)
  if (existing && existing.finalized_at) return

  // Drain any in-flight batched events before we read events.jsonl to build
  // the transcript.
  await flushSession(sessionId)

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

  // finalizeSession now only gets called for errors or explicit cancels —
  // non-error parks go through `updateMeta({ status: 'idle' })` in the
  // registry's turn_finished handler instead. The status we land on is
  // either 'error' (hard failure) or 'idle' (everything else, resumable).
  writeMeta(sessionId, {
    ...meta,
    status: statusForMeta(meta.status, opts.error ?? meta.error),
    output: opts.output ?? meta.output,
    error: opts.error ?? meta.error,
    finished_at: meta.finished_at ?? Date.now(),
    artifact_count: artifactCount,
    finalized_at: Date.now(),
  })
}

// ---------- events ----------

/**
 * Event kinds whose appearance on disk the UI depends on *immediately* —
 * the client receives the SSE frame, schedules a refetch ~60ms later,
 * and that refetch reads events.jsonl to build the chat feed. Events on
 * the default 100ms flush interval can race the refetch, so the ask card
 * (for example) doesn't appear until a second refetch or page reload.
 *
 * Forcing a flush on these kinds is cheap — they're rare and tiny.
 */
const UI_CRITICAL_EVENT_KINDS = new Set(['user_question', 'user_answered'])

export function appendSessionEvent(input: AppendEventInput): void {
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
  enqueueEvent(input.sessionId, JSON.stringify(row))
  if (UI_CRITICAL_EVENT_KINDS.has(input.kind)) {
    // Fire-and-forget — the regular interval would catch it eventually,
    // but we want it durable before the client's refetch window.
    void flushSession(input.sessionId).catch(() => {
      /* ignore — next flush cycle will retry */
    })
  }
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

/** Permanently remove a session's on-disk footprint: the session dir
 *  (meta.json + events.jsonl + transcript.jsonl + artifacts/ + usage.json)
 *  AND the hashed artifact payload dir under artifactsRoot/. Safe to call
 *  when files are missing. Returns true if the session dir existed. */
export function deleteSession(sessionId: string): boolean {
  const dir = sessionDir(sessionId)
  const existed = fs.existsSync(dir)
  try { fs.rmSync(dir, { recursive: true, force: true }) }
  catch { /* best-effort */ }
  try { fs.rmSync(artifactDirForSession(sessionId), { recursive: true, force: true }) }
  catch { /* best-effort */ }
  return existed
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

/** Any session whose meta.json still says status='running' on boot was in
 *  flight when the process died. Demote them to `idle` so they stop showing
 *  as live and become resumable. We do NOT finalize the transcript or write
 *  an error — the session isn't failed, it's just waiting. The next user
 *  message re-launches the engine via session-registry.resume(). */
/** Scan a session's events.jsonl and decide what its "real" status is based
 *  on what happened, not what meta.status happens to say. Used at boot to
 *  reconcile sessions whose meta drifted from reality (e.g. ask_user fired
 *  before the driveSession status-flip transition existed, or a crash
 *  between emitting an event and writing meta). */
function reconcileStatusFromEvents(sessionId: string): SessionStatus | null {
  const events = eventsForSession(sessionId)
  if (events.length === 0) return null
  // Unanswered ask_user → needs_input. The engine is parked on the tool call
  // and the user can still answer it (the stored tool_call_id is the key).
  const answered = new Set<string>()
  for (const e of events) {
    if (e.kind === 'user_answered' && e.tool_call_id) answered.add(e.tool_call_id)
  }
  const latestQuestion = [...events]
    .reverse()
    .find((e) => e.kind === 'user_question' && e.tool_call_id)
  if (latestQuestion && !answered.has(latestQuestion.tool_call_id!)) {
    return 'needs_input'
  }
  // Hard error already recorded — respect it.
  const hasError = events.some((e) => e.kind === 'run_error')
  if (hasError) return 'error'
  // Everything else: turn-finished parks, mid-turn process deaths, etc. all
  // collapse to idle. Resumable via follow-up message.
  return 'idle'
}

/** Boot-time reconciliation. Walks every session and fixes meta.status that
 *  can't possibly be `running` anymore (the process just started — nothing
 *  is actively generating). Looks at events.jsonl to tell apart genuine
 *  idle sessions from sessions parked on an unanswered ask_user, so the
 *  inbox surfaces the right color on first paint even without an SSE
 *  attach. */
export async function markOrphanedSessionsIdle(): Promise<number> {
  let n = 0
  for (const id of listSessionIds()) {
    const meta = readMeta(id)
    if (!meta) continue
    if (meta.status !== 'running') continue
    const real = reconcileStatusFromEvents(id) ?? 'idle'
    updateMeta(id, {
      status: real,
      // finished_at only makes sense for non-live states.
      finished_at: real === 'running' ? null : (meta.finished_at ?? Date.now()),
    })
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
