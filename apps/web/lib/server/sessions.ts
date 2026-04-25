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

/** Session status — explicit state machine. Lives in meta.json so the UI and
 *  any future resume logic have ground truth without rescanning events on
 *  every load.
 *
 *    pending      = created, no engine event yet. Transient — the registry
 *                   flips to `running` as soon as the first event lands.
 *    running      = a turn is currently being generated (live tokens flowing)
 *                   AND the owning process is alive. Heartbeat keeps
 *                   `last_alive_at` fresh; boot reconciliation uses that to
 *                   tell apart a real running session (impossible at boot —
 *                   we just started) from one whose process was killed.
 *    needs_input  = parked on an unanswered ask_user question. The engine
 *                   literally cannot proceed until the user answers (or skips).
 *                   Distinct from `idle` because the UI must keep surfacing
 *                   this as a pending action — otherwise the user navigates
 *                   away, the orange dot disappears on their next visit, and
 *                   the session sits forever waiting.
 *    idle         = turn done cleanly, waiting for the next user message.
 *                   Resumable.
 *    abandoned    = process died mid-turn (kill -9, OOM, hard crash). We
 *                   detected the gap on boot — the engine generator is gone
 *                   and there's no clean way to resume mid-tool-call. The
 *                   user can start a new follow-up message, which spins up a
 *                   fresh engine via resume() with the persisted history,
 *                   but the in-flight tool call from the previous process is
 *                   considered lost. Distinct from `idle` so the UI can show
 *                   "your previous run was interrupted — continue?" instead
 *                   of silently pretending nothing happened.
 *    error        = errored out in a way we don't auto-recover from. */
export type SessionStatus =
  | 'pending'
  | 'running'
  | 'needs_input'
  | 'idle'
  | 'abandoned'
  | 'error'

/** Structured reason an abandoned session was classified as such. Persisted
 *  alongside `meta.status='abandoned'` so the UI can surface a precise
 *  explanation and any future resume code can decide whether to retry.
 *
 *    process_killed_mid_run  — heartbeat went stale while status was
 *                              'running'. The owning Node process almost
 *                              certainly died (kill, OOM, hard crash).
 *    graceful_shutdown       — SIGTERM/SIGINT fired during a turn; the
 *                              shutdown handler marked it before exit so we
 *                              have a clean signal on next boot.
 *    no_terminal_event       — meta says 'running' but events.jsonl is
 *                              missing the corresponding terminal event AND
 *                              we have no heartbeat to confirm liveness.
 *                              Conservative fallback for legacy sessions
 *                              that predate the heartbeat field. */
export interface AbandonedReason {
  kind:
    | 'process_killed_mid_run'
    | 'graceful_shutdown_during_turn'
    | 'no_terminal_event'
    | 'provider_silent_exit'
    | 'skill_subprocess_hung'
    | 'unknown'
  last_event_seq: number | null
  last_event_kind: string | null
  last_event_ts: number | null
  detected_at: number
  /** When kind === 'skill_subprocess_hung', the tool that was in flight at
   *  the tail of events.jsonl. Lets the UI surface "web-search hung" instead
   *  of a generic "process died" message. */
  tool_name?: string | null
  tool_call_id?: string | null
}

/** Structured error detail. `meta.error` (string) is kept for backward
 *  compatibility with existing readers; `error_detail` carries the richer
 *  classification. */
export interface ErrorDetail {
  kind: string
  message: string
  ts: number
}

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
  /** Epoch ms of when the user first opened this session's result. Persisted
   *  so "new result" badges don't flash back on every page reload or server
   *  restart. null / missing = never viewed. Set by PATCH {viewed:true}. */
  viewed_at?: number | null
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
  /** Heartbeat — epoch ms last refreshed by the owning process while a turn
   *  was in `running` state. Boot reconciliation compares
   *  `now - last_alive_at` against `STALE_HEARTBEAT_MS` to classify an
   *  unfinished `running` session as abandoned. Updated in-place via
   *  meta.json (no event-log bloat). null/undefined for sessions started
   *  before this field existed — those fall back to `no_terminal_event`. */
  last_alive_at?: number | null
  /** Seq number of the last event emitted by the owning process. Updated by
   *  the same heartbeat write, so on boot we can decide "did meta drift from
   *  events.jsonl?" without rescanning the whole file every load. */
  last_event_seq?: number | null
  /** When the session entered `abandoned`, in epoch ms. */
  abandoned_at?: number | null
  /** Why the session was classified as abandoned. */
  abandoned_reason?: AbandonedReason | null
  /** Structured error info — companion to the legacy `error` string. */
  error_detail?: ErrorDetail | null
}

/** A turn is considered alive if its heartbeat fired within this window.
 *  Set comfortably larger than the 30s heartbeat interval so a normal flush
 *  hiccup doesn't trip a false abandoned classification, but small enough
 *  that a real crash is detected on the next boot rather than days later. */
export const STALE_HEARTBEAT_MS = 90_000

/** How often a live `running` session refreshes meta.last_alive_at. Cheap —
 *  just a meta.json rewrite, no event-log line. */
export const HEARTBEAT_INTERVAL_MS = 30_000

function normalizeStatus(raw: unknown): SessionStatus {
  if (
    raw === 'pending' ||
    raw === 'running' ||
    raw === 'needs_input' ||
    raw === 'idle' ||
    raw === 'abandoned' ||
    raw === 'error'
  ) {
    return raw
  }
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

/** Scratch dir — internal working files produced by research/verify
 *  sub-agents. Lives alongside artifacts/ but is NOT surfaced to the user
 *  (not registered in artifacts.json, not included in the <session-artifacts>
 *  manifest, not returned by listForSession). Per-node subdirectory keeps
 *  sibling workers from trampling each other's scratch files. */
export function sessionScratchDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'scratch')
}
export function scratchDirForNode(sessionId: string, nodeId: string): string {
  // Node IDs are internal slugs (e.g. 'a-ce59a9') — safe to use verbatim.
  return path.join(sessionScratchDir(sessionId), nodeId)
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
export function updateMeta(sessionId: string, patch: Partial<SessionMeta>): SessionMeta | null {
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
    // First heartbeat: we're alive right now. Boot reconciliation needs a
    // non-null timestamp to even consider this session non-abandoned.
    last_alive_at: now,
    last_event_seq: 0,
    abandoned_at: null,
    abandoned_reason: null,
    error_detail: null,
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
    try {
      fs.rmdirSync(artDir)
    } catch {
      /* ignore */
    }
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
        seq: number
        ts: number
        kind: string
        depth: number
        node_id: string | null
        tool_call_id: string | null
        tool_name: string | null
        data_json?: string
        data?: Record<string, unknown>
      }
      out.push({
        seq: row.seq,
        ts: row.ts,
        kind: row.kind,
        depth: row.depth,
        node_id: row.node_id,
        tool_call_id: row.tool_call_id,
        tool_name: row.tool_name,
        data:
          row.data ?? (row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : {}),
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
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(artifactDirForSession(sessionId), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(sessionScratchDir(sessionId), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
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

/** Terminal events the engine emits at the end of a turn. If any of these
 *  is the last event in events.jsonl, the previous process exited the run
 *  loop cleanly and the session is `idle`, not abandoned. */
const TERMINAL_EVENT_KINDS = new Set([
  'run_finished',
  'turn_finished',
  'run_error',
])

/** Boot-time reconciliation result for one session. */
export interface ReconcileResult {
  sessionId: string
  previousStatus: SessionStatus
  newStatus: SessionStatus
  reason: AbandonedReason | null
}

/** Inspect a single session's meta + events tail and decide what its real
 *  status is now that the previous owning process is definitely gone. Pure
 *  classifier — doesn't touch disk. Caller (`reconcileSessionsOnBoot`)
 *  applies the result. */
export function classifyOnBoot(
  meta: SessionMeta,
  lastEvent: StoredEventRow | null,
  now: number = Date.now(),
): { status: SessionStatus; reason: AbandonedReason | null; errorDetail: ErrorDetail | null } {
  // Already-terminal statuses are respected as-is — nothing for us to do.
  if (meta.status === 'idle' || meta.status === 'abandoned' || meta.status === 'error') {
    return { status: meta.status, reason: meta.abandoned_reason ?? null, errorDetail: meta.error_detail ?? null }
  }

  // Note: `needs_input` (unanswered ask_user) is decided by the caller in
  // `reconcileSessionsOnBoot` via a full event scan. This classifier sees
  // only the meta + last event and focuses on the running/abandoned/error
  // axis.

  // run_error already on disk → terminal error.
  if (lastEvent?.kind === 'run_error') {
    const message =
      typeof lastEvent.data?.error === 'string' ? (lastEvent.data.error as string) : 'unknown error'
    return {
      status: 'error',
      reason: null,
      errorDetail: { kind: 'run_error', message, ts: lastEvent.ts },
    }
  }

  // Clean park: last event is turn_finished/run_finished → idle.
  if (lastEvent && TERMINAL_EVENT_KINDS.has(lastEvent.kind)) {
    return { status: 'idle', reason: null, errorDetail: null }
  }

  // Status was running/needs_input/pending and no terminal event landed.
  // Decide between abandoned (process died) and graceful_shutdown by looking
  // at the heartbeat. (A pre-existing graceful_shutdown abandoned marker
  // was already returned above by the early-exit on terminal statuses.)
  const heartbeat = meta.last_alive_at ?? null
  const lastSeq = lastEvent?.seq ?? null
  const lastKind = lastEvent?.kind ?? null
  const lastTs = lastEvent?.ts ?? null
  const isStaleHeartbeat = heartbeat == null || now - heartbeat > STALE_HEARTBEAT_MS

  // If heartbeat is fresh, we still consider this abandoned at boot — by
  // definition the process that wrote that heartbeat is no longer running
  // (this code only runs at boot). We use the freshness to pick a kinder
  // reason kind.
  const reason: AbandonedReason = {
    kind: heartbeat == null
      ? 'no_terminal_event'
      : 'process_killed_mid_run',
    last_event_seq: lastSeq,
    last_event_kind: lastKind,
    last_event_ts: lastTs,
    detected_at: now,
  }
  if (!isStaleHeartbeat && heartbeat != null) {
    // Heartbeat was recent but we're at boot — the process must have died
    // very recently. Still abandoned, classification stays as
    // process_killed_mid_run for clarity.
    reason.kind = 'process_killed_mid_run'
  }
  // If the tail event is `tool_called` / `skill.started` / `skill.queued`
  // — i.e. the engine dispatched a tool/skill but never wrote the matching
  // `tool_result` / `skill.finished` — the skill subprocess almost
  // certainly hung past the engine's tool-call timeout (or the parent
  // process died waiting for it). Distinct from `provider_silent_exit`
  // (which fires when the provider stream died AFTER a tool_result
  // landed) so the UI can show "web-search hung" instead of a generic
  // "provider stalled" message. Stamp the tool name/call id so callers
  // can surface which tool was in flight. This branch must come BEFORE
  // the `tool_result → provider_silent_exit` check below.
  if (
    lastEvent?.kind === 'tool_called' ||
    lastEvent?.kind === 'skill.started' ||
    lastEvent?.kind === 'skill.queued'
  ) {
    reason.kind = 'skill_subprocess_hung'
    reason.tool_name = lastEvent.tool_name ?? null
    reason.tool_call_id = lastEvent.tool_call_id ?? null
    return { status: 'abandoned', reason, errorDetail: null }
  }
  // If the tail event is a `tool_result` (or any non-terminal kind that
  // landed AFTER a tool_called and BEFORE a hypothetical
  // round_finished/node_finished), we know the provider stream silently
  // exited mid-round — the engine was waiting on the next provider delta
  // and never got one. This is a structural diagnosis (independent of
  // heartbeat freshness), so we override the kind here. Sessions where
  // Fix A (streamTurn try/catch) catches the throw will instead land with
  // a `node_finished{stop_reason:'provider_error'}` tail and classify as
  // idle — exactly what we want.
  if (lastEvent?.kind === 'tool_result') {
    reason.kind = 'provider_silent_exit'
  }
  return { status: 'abandoned', reason, errorDetail: null }
}

/** Boot-time reconciliation. Walks every session and replaces stale
 *  in-flight statuses with one of `idle | needs_input | abandoned | error`.
 *  No session is silently demoted to `idle` anymore — an interrupted run
 *  becomes `abandoned` with a structured reason so the UI can surface
 *  "previous run was interrupted" instead of pretending nothing happened.
 *
 *  Tolerant of legacy meta.json missing the new fields. Logs at INFO level
 *  one line per reclassification. */
export async function reconcileSessionsOnBoot(
  now: number = Date.now(),
): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = []
  for (const id of listSessionIds()) {
    const meta = readMeta(id)
    if (!meta) continue
    // Only reconsider non-terminal statuses. `pending` is also reconsidered —
    // a session created mid-flight that never got its first event is just
    // garbage state from a process death.
    if (
      meta.status !== 'running' &&
      meta.status !== 'needs_input' &&
      meta.status !== 'pending'
    ) {
      continue
    }
    const events = eventsForSession(id)
    const lastEvent: StoredEventRow | null =
      events.length > 0 ? (events[events.length - 1] ?? null) : null

    // Full ask_user scan: an unanswered question parks the session in
    // needs_input regardless of where it sits in the event stream.
    let needsInput = false
    if (events.length > 0) {
      const answered = new Set<string>()
      for (const e of events) {
        if (e.kind === 'user_answered' && e.tool_call_id) answered.add(e.tool_call_id)
      }
      const latestQuestion = [...events]
        .reverse()
        .find((e) => e.kind === 'user_question' && e.tool_call_id)
      if (latestQuestion && !answered.has(latestQuestion.tool_call_id!)) {
        needsInput = true
      }
    }

    let newStatus: SessionStatus
    let reason: AbandonedReason | null = null
    let errorDetail: ErrorDetail | null = null

    if (needsInput) {
      newStatus = 'needs_input'
    } else {
      const cls = classifyOnBoot(meta, lastEvent, now)
      newStatus = cls.status
      reason = cls.reason
      errorDetail = cls.errorDetail
    }

    if (newStatus === meta.status && !reason && !errorDetail) {
      // No change — skip the write.
      continue
    }

    const patch: Partial<SessionMeta> = {
      status: newStatus,
      finished_at: newStatus === 'running' ? null : (meta.finished_at ?? now),
    }
    if (newStatus === 'abandoned') {
      patch.abandoned_at = now
      patch.abandoned_reason = reason
    } else {
      // Clear stale abandoned markers if we transitioned out of abandoned
      // (e.g. legacy session that actually has a clean turn_finished tail).
      patch.abandoned_at = null
      patch.abandoned_reason = null
    }
    if (newStatus === 'error') {
      patch.error_detail = errorDetail
      if (errorDetail && !meta.error) patch.error = errorDetail.message
    }
    updateMeta(id, patch)

    results.push({
      sessionId: id,
      previousStatus: meta.status,
      newStatus,
      reason,
    })

    // INFO-level log per reclassification so the operator sees on startup
    // exactly which sessions were affected and why.
    if (newStatus === 'abandoned' && reason) {
      console.log(
        `boot: session ${id} reclassified ${meta.status} → abandoned ` +
          `(${reason.kind}, last_event=${reason.last_event_kind}#${reason.last_event_seq})`,
      )
    } else if (newStatus !== meta.status) {
      console.log(`boot: session ${id} reclassified ${meta.status} → ${newStatus}`)
    }
  }
  return results
}

/** @deprecated Use `reconcileSessionsOnBoot`. Kept ONLY as a thin no-arg
 *  shim for any in-tree caller that hasn't been updated yet — returns the
 *  count of reclassified sessions. New code MUST call
 *  `reconcileSessionsOnBoot()` directly to get structured results. */
export async function markOrphanedSessionsIdle(): Promise<number> {
  const r = await reconcileSessionsOnBoot()
  return r.length
}

// ---------- heartbeat ----------

/** Update the in-memory + on-disk heartbeat for a live session. Cheap:
 *  meta.json rewrite, no event-log line. Called periodically by the
 *  registry's driveSession() while a turn is in `running` state. */
export function touchHeartbeat(sessionId: string, lastEventSeq: number | null): void {
  updateMeta(sessionId, {
    last_alive_at: Date.now(),
    last_event_seq: lastEventSeq,
  })
}

/** Mark every currently-`running` session as abandoned with a graceful
 *  shutdown reason. Called from the SIGTERM/SIGINT handler so that on the
 *  next boot, reconciliation has the cleanest possible signal — the user
 *  sees "your previous run was interrupted by a server restart" instead of
 *  the noisier "process killed" classification. Synchronous on purpose:
 *  the shutdown handler is racing exit. */
export function markRunningSessionsAbandonedSync(now: number = Date.now()): number {
  let n = 0
  for (const id of listSessionIds()) {
    const meta = readMeta(id)
    if (!meta) continue
    if (meta.status !== 'running' && meta.status !== 'needs_input' && meta.status !== 'pending') {
      continue
    }
    // needs_input is a legitimate park — the process was waiting on the
    // user, not actively generating. Don't reclassify those as abandoned;
    // they're still resumable via the answer endpoint.
    if (meta.status === 'needs_input') continue

    const events = eventsForSession(id)
    const lastEvent: StoredEventRow | null =
      events.length > 0 ? (events[events.length - 1] ?? null) : null
    const reason: AbandonedReason = {
      kind: 'graceful_shutdown_during_turn',
      last_event_seq: lastEvent?.seq ?? null,
      last_event_kind: lastEvent?.kind ?? null,
      last_event_ts: lastEvent?.ts ?? null,
      detected_at: now,
    }
    updateMeta(id, {
      status: 'abandoned',
      finished_at: meta.finished_at ?? now,
      abandoned_at: now,
      abandoned_reason: reason,
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

/** Shape rendered by `SourceCard` in the chat UI. Kept flat + JSON-serialisable
 *  because it travels through the transcript → SessionSummary → client. */
export interface TranscriptSource {
  title: string
  url: string
  domain: string
  snippet?: string
  rank?: number
}

/** Parse the JSON body of a `tool_result` for web-search / web-fetch and
 *  return a normalised source list. Returns `null` if parse fails or the
 *  shape is unexpected — caller falls back to a plain tool chip. */
function extractSources(
  toolName: string,
  resultEvent: StoredEventRow,
): TranscriptSource[] | null {
  const content = resultEvent.data.content
  if (typeof content !== 'string' || !content.trim()) return null
  // The skillTool handler wraps skill stdout in
  // `{ok, exit_code, stdout, stderr, files}` — the interesting body is in
  // `stdout`. Some older/custom paths put the payload directly. Handle both.
  let body: unknown
  try {
    body = JSON.parse(content)
  } catch {
    return null
  }
  let payload: unknown = body
  if (body && typeof body === 'object' && 'stdout' in (body as Record<string, unknown>)) {
    const stdout = (body as Record<string, unknown>).stdout
    if (typeof stdout === 'string' && stdout.trim()) {
      try {
        payload = JSON.parse(stdout)
      } catch {
        return null
      }
    }
  }
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (p.ok === false) return null

  if (toolName === 'web-search') {
    const results = p.results
    if (!Array.isArray(results)) return null
    const out: TranscriptSource[] = []
    for (const r of results) {
      if (!r || typeof r !== 'object') continue
      const rr = r as Record<string, unknown>
      const url = typeof rr.url === 'string' ? rr.url : ''
      const title = typeof rr.title === 'string' ? rr.title : ''
      if (!url || !title) continue
      out.push({
        title,
        url,
        domain: typeof rr.domain === 'string' ? rr.domain : domainFromUrl(url),
        snippet: typeof rr.snippet === 'string' ? rr.snippet : undefined,
        rank: typeof rr.rank === 'number' ? rr.rank : undefined,
      })
    }
    return out.length > 0 ? out : null
  }

  if (toolName === 'web-fetch') {
    const url = typeof p.url === 'string' ? p.url : ''
    if (!url) return null
    const title =
      typeof p.title === 'string' && p.title.trim()
        ? p.title
        : domainFromUrl(url) || url
    const contentStr = typeof p.content === 'string' ? p.content : ''
    return [
      {
        title,
        url,
        domain: domainFromUrl(url),
        snippet: contentStr ? contentStr.slice(0, 160) : undefined,
      },
    ]
  }

  return null
}

function domainFromUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return u.hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

export function buildTranscript(
  goal: string,
  startedAt: number,
  events: StoredEventRow[],
): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [{ kind: 'goal', text: goal, ts: startedAt / 1000 }]
  // Pre-index tool_result events by tool_call_id so we can attach parsed
  // sources to the corresponding tool_call entry without an O(n^2) scan.
  const resultByCallId = new Map<string, StoredEventRow>()
  // Pre-index delegation_opened by tool_call_id so we can hand the
  // engine-stamped `sibling_group_id` back to the matching
  // delegate_parallel tool_called row — the call event itself doesn't
  // carry it, only the opening event does.
  const openedByCallId = new Map<string, StoredEventRow>()
  for (const ev of events) {
    if (ev.kind === 'tool_result' && ev.tool_call_id) {
      resultByCallId.set(ev.tool_call_id, ev)
    } else if (ev.kind === 'delegation_opened' && ev.tool_call_id) {
      openedByCallId.set(ev.tool_call_id, ev)
    }
  }
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
    } else if (ev.kind === 'tool_called') {
      // Lead-level (depth=0) tool calls always surface. Sub-agent tool calls
      // normally stay in events.jsonl only, EXCEPT for the few tools the
      // user wants visible regardless of who called them:
      //   - `web-search` / `web-fetch` — research steps the user reads.
      //   - `delegate_to` / `delegate_parallel` — sub-agents handing off
      //     their own work; the FE's nesting pass needs every link in the
      //     chain to render the call tree, otherwise grandchildren escape
      //     to the root level (looks like the Lead did it directly).
      const isWeb =
        ev.tool_name === 'web-search' || ev.tool_name === 'web-fetch'
      const isDelegate =
        ev.tool_name === 'delegate_to' || ev.tool_name === 'delegate_parallel'
      if (ev.depth !== 0 && !isWeb && !isDelegate) continue
      const result =
        isWeb && ev.tool_call_id ? resultByCallId.get(ev.tool_call_id) : null
      const sources =
        isWeb && result ? extractSources(ev.tool_name ?? '', result) : null
      // Surface delegate_parallel sibling metadata so the FE can disambiguate
      // children of N concurrent same-role instances (they all share a
      // node_id, so depth+nodeId alone can't tell which instance owned a
      // given web-fetch).
      //   * For nested tool_called events, the engine stamps
      //     sibling_group_id / sibling_index on `data` directly.
      //   * For the parallel call ITSELF, the call's data only has
      //     `arguments`; the engine emits the group id on the matching
      //     `delegation_opened` event. Fall back to that when the call
      //     event is the parent of the fan-out.
      let siblingGroupId =
        typeof ev.data?.sibling_group_id === 'string'
          ? (ev.data.sibling_group_id as string)
          : undefined
      const siblingIndex =
        typeof ev.data?.sibling_index === 'number'
          ? (ev.data.sibling_index as number)
          : undefined
      if (
        !siblingGroupId &&
        ev.tool_name === 'delegate_parallel' &&
        ev.tool_call_id
      ) {
        const opened = openedByCallId.get(ev.tool_call_id)
        const v = opened?.data?.sibling_group_id
        if (typeof v === 'string') siblingGroupId = v
      }
      lines.push({
        kind: 'tool_call',
        ts: ev.ts,
        node_id: ev.node_id,
        tool: ev.tool_name,
        args: ev.data.arguments,
        sources: sources ?? undefined,
        depth: ev.depth,
        sibling_group_id: siblingGroupId,
        sibling_index: siblingIndex,
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
        try {
          fs.unlinkSync(abs)
        } catch {
          /* ignore */
        }
      } else {
        allEmpty = false
      }
    }
    if (allEmpty && dir !== root) {
      try {
        fs.rmdirSync(dir)
      } catch {
        /* ignore */
      }
    }
    return allEmpty
  }
  if (walk(root)) {
    try {
      fs.rmdirSync(root)
    } catch {
      /* ignore */
    }
  }
}

export function pruneLegacyArtifactsRoot(): void {
  pruneEmptyTree(artifactsRoot())
}
