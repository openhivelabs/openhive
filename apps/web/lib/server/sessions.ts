/**
 * Session store — canonical record of one engine run.
 *
 * Layout:
 *   ~/.openhive/sessions/{uuid}/
 *     meta.json        session/run metadata (id, uuid, goal, status, times)
 *     transcript.jsonl user/assistant/tool/ask_user messages, one per line
 *     events.jsonl     full run_events dump (debugging fidelity)
 *     artifacts/       generated files — created lazily only when written
 *
 * The engine stays session-agnostic; we attach at start/finish via the
 * run-registry lifecycle hooks. `runs.session_uuid` is the sole link
 * between engine runId and this directory.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getDb } from './db'
import { artifactsRoot, sessionsRoot } from './paths'
import { eventsFor } from './runs-store'

export interface SessionMeta {
  uuid: string
  run_id: string
  team_id: string | null
  goal: string
  status: 'running' | 'finished' | 'error' | 'interrupted'
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  artifact_count: number
}

export function sessionDir(uuid: string): string {
  return path.join(sessionsRoot(), uuid)
}

export function sessionArtifactDir(uuid: string): string {
  return path.join(sessionDir(uuid), 'artifacts')
}

export function sessionMetaPath(uuid: string): string {
  return path.join(sessionDir(uuid), 'meta.json')
}

function readMeta(uuid: string): SessionMeta | null {
  try {
    const raw = fs.readFileSync(sessionMetaPath(uuid), 'utf8')
    return JSON.parse(raw) as SessionMeta
  } catch {
    return null
  }
}

function writeMeta(uuid: string, meta: SessionMeta): void {
  fs.mkdirSync(sessionDir(uuid), { recursive: true })
  fs.writeFileSync(
    sessionMetaPath(uuid),
    JSON.stringify(meta, null, 2),
    'utf8',
  )
}

function lookupSessionUuid(runId: string): string | null {
  const row = getDb()
    .prepare('SELECT session_uuid FROM runs WHERE id = ?')
    .get(runId) as { session_uuid: string | null } | undefined
  return row?.session_uuid ?? null
}

/** Called by run-registry the moment a run starts streaming events. */
export function createSession(
  runId: string,
  teamId: string | null,
  goal: string,
): string {
  const existing = lookupSessionUuid(runId)
  if (existing) return existing
  const uuid = crypto.randomUUID()
  getDb()
    .prepare('UPDATE runs SET session_uuid = ? WHERE id = ?')
    .run(uuid, runId)
  const now = Date.now()
  writeMeta(uuid, {
    uuid,
    run_id: runId,
    team_id: teamId,
    goal,
    status: 'running',
    output: null,
    error: null,
    started_at: now,
    finished_at: null,
    artifact_count: 0,
  })
  return uuid
}

/** Tools call this to get the output directory for file-producing skills.
 *  Auto-creates a session if one is somehow missing for a known run. */
export function artifactDirForRun(runId: string): string {
  let uuid = lookupSessionUuid(runId)
  if (!uuid) {
    // Engine called before createSession (should be rare — backfill path).
    const run = getDb()
      .prepare('SELECT team_id, goal FROM runs WHERE id = ?')
      .get(runId) as { team_id: string; goal: string } | undefined
    uuid = createSession(runId, run?.team_id ?? null, run?.goal ?? '')
  }
  return sessionArtifactDir(uuid)
}

/** Build the distilled transcript lines from a full event list. */
function buildTranscript(
  goal: string,
  startedAt: number,
  events: ReturnType<typeof eventsFor>,
): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [
    { kind: 'goal', text: goal, ts: startedAt / 1000 },
  ]
  for (const ev of events) {
    if (ev.kind === 'user_question') {
      lines.push({
        kind: 'ask_user',
        ts: ev.ts,
        agent_role: (ev.data as Record<string, unknown>)?.agent_role,
        questions: (ev.data as Record<string, unknown>)?.questions,
      })
    } else if (ev.kind === 'user_answered') {
      lines.push({
        kind: 'user_answer',
        ts: ev.ts,
        result: (ev.data as Record<string, unknown>)?.result,
      })
    } else if (ev.kind === 'tool_called') {
      lines.push({
        kind: 'tool_call',
        ts: ev.ts,
        node_id: ev.node_id,
        tool: ev.tool_name,
        args: (ev.data as Record<string, unknown>)?.arguments,
      })
    } else if (ev.kind === 'node_finished') {
      const output = (ev.data as Record<string, unknown>)?.output
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
  uuid: string,
  goal: string,
  startedAt: number,
  events: ReturnType<typeof eventsFor>,
): void {
  if (events.length > 0) {
    fs.writeFileSync(
      path.join(sessionDir(uuid), 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )
  }
  const lines = buildTranscript(goal, startedAt, events)
  fs.writeFileSync(
    path.join(sessionDir(uuid), 'transcript.jsonl'),
    lines.map((t) => JSON.stringify(t)).join('\n') + '\n',
    'utf8',
  )
}

/** End-of-run dump: meta update + transcript + full event log. No-op if
 *  the session was never created (shouldn't happen in normal flow). */
export function finalizeSession(
  runId: string,
  opts: { output?: string | null; error?: string | null } = {},
): void {
  const uuid = lookupSessionUuid(runId)
  if (!uuid) return
  const meta = readMeta(uuid)
  if (!meta) return

  const status: SessionMeta['status'] = opts.error
    ? opts.error === 'interrupted' || opts.error === 'cancelled'
      ? 'interrupted'
      : 'error'
    : 'finished'

  const events = eventsFor(runId)
  writeTranscriptAndEvents(uuid, meta.goal, meta.started_at, events)

  // Drop the artifacts subdir if nothing was written. Keeps the layout
  // "only present when generated" as the user specified.
  const artDir = sessionArtifactDir(uuid)
  if (fs.existsSync(artDir)) {
    const entries = fs.readdirSync(artDir)
    if (entries.length === 0) {
      fs.rmdirSync(artDir)
    }
  }
  const artifactCount = fs.existsSync(artDir) ? fs.readdirSync(artDir).length : 0

  writeMeta(uuid, {
    ...meta,
    status,
    output: opts.output ?? meta.output,
    error: opts.error ?? null,
    finished_at: Date.now(),
    artifact_count: artifactCount,
  })
}

/** UI discovery — scans the sessions dir and returns most-recent first. */
export function listSessions(limit = 100): SessionMeta[] {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return []
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  const metas: SessionMeta[] = []
  for (const name of dirs) {
    const m = readMeta(name)
    if (m) metas.push(m)
  }
  metas.sort((a, b) => b.started_at - a.started_at)
  return metas.slice(0, limit)
}

export function getSession(uuid: string): SessionMeta | null {
  return readMeta(uuid)
}

export function sessionUuidForRun(runId: string): string | null {
  return lookupSessionUuid(runId)
}

// -------- boot-time migration --------

/** Retrofit sessions for every historical run so the new layout isn't empty.
 *  Runs once per process start; idempotent (skips runs that already have a
 *  session_uuid). Also moves old artifact files from the legacy
 *  artifacts/{company}/{team}/{run_id}/ layout into sessions/{uuid}/artifacts/
 *  and rewrites the artifacts.path column. Returns the number of sessions
 *  created. */
export function backfillSessions(): number {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, team_id, goal, status, output, error, started_at, finished_at
         FROM runs WHERE session_uuid IS NULL`,
    )
    .all() as {
    id: string
    team_id: string
    goal: string
    status: string
    output: string | null
    error: string | null
    started_at: number
    finished_at: number | null
  }[]
  let created = 0
  for (const run of rows) {
    const uuid = crypto.randomUUID()
    db.prepare('UPDATE runs SET session_uuid = ? WHERE id = ?').run(uuid, run.id)

    // Move legacy artifact files into the session layout.
    const artRows = db
      .prepare('SELECT id, path, filename FROM artifacts WHERE run_id = ?')
      .all(run.id) as { id: string; path: string; filename: string }[]
    let movedCount = 0
    for (const a of artRows) {
      if (!fs.existsSync(a.path)) continue
      const destDir = sessionArtifactDir(uuid)
      fs.mkdirSync(destDir, { recursive: true })
      const dest = path.join(destDir, a.filename)
      try {
        if (a.path !== dest) fs.renameSync(a.path, dest)
        db.prepare('UPDATE artifacts SET path = ? WHERE id = ?').run(dest, a.id)
        movedCount += 1
      } catch (exc) {
        // Cross-device rename (unlikely under ~/.openhive) — fall back to copy.
        try {
          fs.copyFileSync(a.path, dest)
          fs.unlinkSync(a.path)
          db.prepare('UPDATE artifacts SET path = ? WHERE id = ?').run(dest, a.id)
          movedCount += 1
        } catch {
          /* leave it; path still points to old location */
        }
      }
    }

    const status = (run.status === 'running'
      ? 'interrupted'
      : run.status === 'error'
        ? 'error'
        : 'finished') as SessionMeta['status']
    const meta: SessionMeta = {
      uuid,
      run_id: run.id,
      team_id: run.team_id,
      goal: run.goal,
      status,
      output: run.output,
      error: run.error,
      started_at: run.started_at,
      finished_at: run.finished_at,
      artifact_count: movedCount,
    }
    writeMeta(uuid, meta)

    // Write transcript + events.jsonl for this historical run too.
    try {
      const events = eventsFor(run.id)
      writeTranscriptAndEvents(uuid, run.goal, run.started_at, events)
    } catch {
      /* events dump is best-effort */
    }
    created += 1
  }

  // Best-effort cleanup: prune empty legacy directories.
  try {
    pruneEmptyTree(artifactsRoot())
  } catch {
    /* nothing to do */
  }

  return created
}

/** Idempotent repair pass: regenerate missing transcript.jsonl for any
 *  session that was backfilled before this helper existed, and retry the
 *  legacy-artifacts pruning now that junk files are removed. Safe to call
 *  on every boot. */
export function repairSessions(): number {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, team_id, goal, started_at, session_uuid
         FROM runs WHERE session_uuid IS NOT NULL`,
    )
    .all() as {
    id: string
    team_id: string
    goal: string
    started_at: number
    session_uuid: string
  }[]
  let fixed = 0
  for (const run of rows) {
    const uuid = run.session_uuid
    const dir = sessionDir(uuid)
    if (!fs.existsSync(dir)) continue
    const transcript = path.join(dir, 'transcript.jsonl')
    if (fs.existsSync(transcript)) continue
    try {
      const events = eventsFor(run.id)
      writeTranscriptAndEvents(uuid, run.goal, run.started_at, events)
      fixed += 1
    } catch {
      /* best-effort */
    }
  }
  try { pruneEmptyTree(artifactsRoot()) } catch { /* ignore */ }
  return fixed
}

// Junk files macOS (and some other OSes) drop into every directory. They
// shouldn't keep otherwise-empty legacy folders alive after migration.
const JUNK_FILENAMES = new Set(['.DS_Store', 'Thumbs.db', '.localized'])

function pruneEmptyTree(root: string): void {
  if (!fs.existsSync(root)) return
  const walk = (dir: string): boolean => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    let allEmpty = true
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        const childEmpty = walk(abs)
        if (!childEmpty) allEmpty = false
      } else if (JUNK_FILENAMES.has(e.name)) {
        try { fs.unlinkSync(abs) } catch { /* ignore */ }
      } else {
        allEmpty = false
      }
    }
    if (allEmpty && dir !== root) {
      try { fs.rmdirSync(dir) } catch { /* keep going */ }
    }
    return allEmpty
  }
  walk(root)
  try {
    const remaining = fs
      .readdirSync(root)
      .filter((n) => !JUNK_FILENAMES.has(n))
    if (remaining.length === 0) {
      for (const n of fs.readdirSync(root)) {
        try { fs.unlinkSync(path.join(root, n)) } catch { /* ignore */ }
      }
      fs.rmdirSync(root)
    }
  } catch { /* keep */ }
}
