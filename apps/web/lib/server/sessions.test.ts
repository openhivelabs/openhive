/**
 * Tests for the explicit session status state machine + boot reconciliation
 * + heartbeat-based abandoned detection. The previous behaviour silently
 * demoted any `running` session to `idle` on boot, indistinguishable from a
 * legitimate idle park; these tests pin the new design where a killed-mid-
 * run session ends up as `abandoned` with a structured reason.
 *
 * Note: getSettings() caches `dataDir` on first call for the process. We set
 * OPENHIVE_DATA_DIR to a per-file tmp at module import time and rely on
 * vitest running each test file in its own worker (isolated cache).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-sessions-'))
process.env.OPENHIVE_DATA_DIR = TMP_ROOT

// Imported AFTER env is set so getSettings caches the right dataDir.
import {
  HEARTBEAT_INTERVAL_MS,
  STALE_HEARTBEAT_MS,
  appendSessionEvent,
  classifyOnBoot,
  getSession,
  markRunningSessionsAbandonedSync,
  reconcileSessionsOnBoot,
  sessionDir,
  sessionEventsPath,
  sessionMetaPath,
  startSession,
  touchHeartbeat,
  updateMeta,
  type SessionMeta,
} from './sessions'

function freshSession(id: string): void {
  // Wipe + recreate via startSession so each test owns a clean slate.
  try {
    fs.rmSync(sessionDir(id), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  startSession(id, 'team-x', 'goal here', null, null)
}

function readMetaRaw(id: string): SessionMeta {
  return JSON.parse(fs.readFileSync(sessionMetaPath(id), 'utf8')) as SessionMeta
}

function writeEventLine(id: string, line: Record<string, unknown>): void {
  fs.appendFileSync(sessionEventsPath(id), `${JSON.stringify(line)}\n`, 'utf8')
}

afterAll(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('startSession initialises the new state-machine fields', () => {
  it('sets status=running, fresh heartbeat, and clears abandoned/error markers', () => {
    const id = 's-init'
    freshSession(id)
    const meta = readMetaRaw(id)
    expect(meta.status).toBe('running')
    expect(meta.last_alive_at).toBeTypeOf('number')
    expect(meta.last_event_seq).toBe(0)
    expect(meta.abandoned_at).toBeNull()
    expect(meta.abandoned_reason).toBeNull()
    expect(meta.error_detail).toBeNull()
  })
})

describe('classifyOnBoot — pure classifier', () => {
  const baseMeta: SessionMeta = {
    id: 's-cls',
    task_id: null,
    team_id: 't',
    goal: 'g',
    status: 'running',
    output: null,
    error: null,
    started_at: 1,
    finished_at: null,
    artifact_count: 0,
    last_alive_at: null,
    last_event_seq: null,
  }

  it('keeps an already-terminal status untouched', () => {
    expect(classifyOnBoot({ ...baseMeta, status: 'idle' }, null).status).toBe('idle')
    expect(classifyOnBoot({ ...baseMeta, status: 'error' }, null).status).toBe('error')
    expect(classifyOnBoot({ ...baseMeta, status: 'abandoned' }, null).status).toBe('abandoned')
  })

  it('flags running with no terminal event and no heartbeat as abandoned/no_terminal_event', () => {
    const r = classifyOnBoot(baseMeta, null)
    expect(r.status).toBe('abandoned')
    expect(r.reason?.kind).toBe('no_terminal_event')
  })

  it('flags running with a stale heartbeat and tool_result tail as abandoned/provider_silent_exit', () => {
    // tool_result tail is a structural diagnosis: the engine was waiting on
    // the next provider delta and the stream silently died. Overrides
    // process_killed_mid_run regardless of heartbeat freshness.
    const now = 1_000_000
    const r = classifyOnBoot(
      { ...baseMeta, last_alive_at: now - STALE_HEARTBEAT_MS - 60_000 },
      { seq: 4048, ts: 1, kind: 'tool_result', depth: 0, node_id: null, tool_call_id: null, tool_name: 'web-search', data: {} },
      now,
    )
    expect(r.status).toBe('abandoned')
    expect(r.reason?.kind).toBe('provider_silent_exit')
    expect(r.reason?.last_event_seq).toBe(4048)
    expect(r.reason?.last_event_kind).toBe('tool_result')
  })

  it('flags running with a stale heartbeat and a non-tool_result tail as process_killed_mid_run', () => {
    const now = 1_000_000
    const r = classifyOnBoot(
      { ...baseMeta, last_alive_at: now - STALE_HEARTBEAT_MS - 60_000 },
      { seq: 12, ts: 1, kind: 'token', depth: 0, node_id: null, tool_call_id: null, tool_name: null, data: {} },
      now,
    )
    expect(r.status).toBe('abandoned')
    expect(r.reason?.kind).toBe('process_killed_mid_run')
  })

  it('tags provider_silent_exit when tail is tool_result even without heartbeat', () => {
    const r = classifyOnBoot(
      baseMeta,
      { seq: 4048, ts: 1, kind: 'tool_result', depth: 0, node_id: null, tool_call_id: null, tool_name: 'web-search', data: {} },
    )
    expect(r.status).toBe('abandoned')
    expect(r.reason?.kind).toBe('provider_silent_exit')
  })

  it('flags running with a tool_called tail (no matching tool_result) as abandoned/skill_subprocess_hung', () => {
    const r = classifyOnBoot(baseMeta, {
      seq: 100, ts: 1, kind: 'tool_called', depth: 0, node_id: null,
      tool_call_id: 'tc-hung', tool_name: 'web-search', data: {},
    })
    expect(r.status).toBe('abandoned')
    expect(r.reason?.kind).toBe('skill_subprocess_hung')
    expect(r.reason?.tool_name).toBe('web-search')
    expect(r.reason?.tool_call_id).toBe('tc-hung')
  })

  it('does NOT flag skill_subprocess_hung when tool_result tail matches an earlier tool_called', () => {
    // The classifier only sees the tail. A tool_result tail (after an
    // earlier tool_called) means the tool finished — we should land on
    // provider_silent_exit, not skill_subprocess_hung.
    const r = classifyOnBoot(baseMeta, {
      seq: 101, ts: 1, kind: 'tool_result', depth: 0, node_id: null,
      tool_call_id: 'tc-done', tool_name: 'web-search', data: {},
    })
    expect(r.status).toBe('abandoned')
    expect(r.reason?.kind).toBe('provider_silent_exit')
    expect(r.reason?.kind).not.toBe('skill_subprocess_hung')
  })

  it('flags running with a skill.started tail as abandoned/skill_subprocess_hung', () => {
    const r = classifyOnBoot(baseMeta, {
      seq: 200, ts: 1, kind: 'skill.started', depth: 0, node_id: null,
      tool_call_id: 'tc-started', tool_name: 'web-search', data: {},
    })
    expect(r.status).toBe('abandoned')
    expect(r.reason?.kind).toBe('skill_subprocess_hung')
    expect(r.reason?.tool_name).toBe('web-search')
  })

  it('treats a clean turn_finished tail as idle', () => {
    const r = classifyOnBoot(baseMeta, {
      seq: 10, ts: 1, kind: 'turn_finished', depth: 0, node_id: null, tool_call_id: null, tool_name: null, data: {},
    })
    expect(r.status).toBe('idle')
    expect(r.reason).toBeNull()
  })

  it('treats a run_error tail as terminal error with structured detail', () => {
    const r = classifyOnBoot(baseMeta, {
      seq: 5, ts: 99, kind: 'run_error', depth: 0, node_id: null, tool_call_id: null, tool_name: null, data: { error: 'kaboom' },
    })
    expect(r.status).toBe('error')
    expect(r.errorDetail?.message).toBe('kaboom')
  })
})

describe('reconcileSessionsOnBoot', () => {
  beforeEach(() => {
    // Wipe the sessions tree so each test starts fresh.
    const root = path.join(TMP_ROOT, 'sessions')
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('classifies a killed-mid-run session as abandoned, NOT idle', async () => {
    const id = 's-killed'
    freshSession(id)
    // Stale heartbeat — process died long ago.
    updateMeta(id, { last_alive_at: Date.now() - STALE_HEARTBEAT_MS - 120_000 })
    // Last event is a tool_result with no terminal follow-up — exactly the
    // failure mode from the bug report (seq 4048 web-search result, no
    // round_finished/run_finished).
    writeEventLine(id, {
      seq: 4048, ts: Date.now() / 1000, kind: 'tool_result', depth: 0,
      node_id: null, tool_call_id: 'tc1', tool_name: 'web-search', data_json: '{}',
    })

    const results = await reconcileSessionsOnBoot()
    const mine = results.find((r) => r.sessionId === id)
    expect(mine).toBeDefined()
    expect(mine?.newStatus).toBe('abandoned')
    // tool_result tail → structural diagnosis as provider_silent_exit.
    expect(mine?.reason?.kind).toBe('provider_silent_exit')
    expect(mine?.reason?.last_event_seq).toBe(4048)

    const meta = getSession(id)
    expect(meta?.status).toBe('abandoned')
    expect(meta?.abandoned_at).toBeTypeOf('number')
    expect(meta?.abandoned_reason?.kind).toBe('provider_silent_exit')
  })

  it('classifies a session with an unanswered ask_user as needs_input', async () => {
    const id = 's-ask'
    freshSession(id)
    writeEventLine(id, {
      seq: 1, ts: Date.now() / 1000, kind: 'user_question', depth: 0,
      node_id: null, tool_call_id: 'q1', tool_name: 'ask_user',
      data_json: JSON.stringify({ questions: ['what?'] }),
    })
    const results = await reconcileSessionsOnBoot()
    const mine = results.find((r) => r.sessionId === id)
    expect(mine?.newStatus).toBe('needs_input')
  })

  it('classifies a clean turn_finished tail as idle', async () => {
    const id = 's-clean'
    freshSession(id)
    writeEventLine(id, {
      seq: 1, ts: Date.now() / 1000, kind: 'turn_finished', depth: 0,
      node_id: null, tool_call_id: null, tool_name: null,
      data_json: JSON.stringify({ output: 'done' }),
    })
    const results = await reconcileSessionsOnBoot()
    const mine = results.find((r) => r.sessionId === id)
    expect(mine?.newStatus).toBe('idle')
    const meta = getSession(id)
    expect(meta?.abandoned_reason).toBeNull()
  })

  it('is tolerant of legacy meta.json with no heartbeat fields', async () => {
    const id = 's-legacy'
    freshSession(id)
    // Strip the new fields to mimic an on-disk legacy session.
    const m = readMetaRaw(id)
    delete (m as Partial<SessionMeta>).last_alive_at
    delete (m as Partial<SessionMeta>).last_event_seq
    fs.writeFileSync(sessionMetaPath(id), JSON.stringify(m, null, 2), 'utf8')
    // Should not throw, and should land at abandoned/no_terminal_event since
    // we have no heartbeat to lean on.
    const results = await reconcileSessionsOnBoot()
    const mine = results.find((r) => r.sessionId === id)
    expect(mine?.newStatus).toBe('abandoned')
    expect(mine?.reason?.kind).toBe('no_terminal_event')
  })

  it('respects a pre-existing graceful_shutdown abandoned tag', async () => {
    const id = 's-graceful'
    freshSession(id)
    // Pretend the shutdown handler already ran in the previous process.
    updateMeta(id, {
      status: 'abandoned',
      abandoned_at: Date.now() - 1000,
      abandoned_reason: {
        kind: 'graceful_shutdown_during_turn',
        last_event_seq: 3,
        last_event_kind: 'tool_called',
        last_event_ts: 1,
        detected_at: Date.now() - 1000,
      },
    })
    const results = await reconcileSessionsOnBoot()
    // Already terminal — not reclassified.
    expect(results.find((r) => r.sessionId === id)).toBeUndefined()
    const meta = getSession(id)
    expect(meta?.abandoned_reason?.kind).toBe('graceful_shutdown_during_turn')
  })
})

describe('touchHeartbeat', () => {
  it('updates last_alive_at and last_event_seq in-place', async () => {
    const id = 's-hb'
    freshSession(id)
    const before = readMetaRaw(id).last_alive_at as number
    // Force a small delay so timestamps differ.
    await new Promise((r) => setTimeout(r, 10))
    touchHeartbeat(id, 42)
    const after = readMetaRaw(id)
    expect(after.last_alive_at).toBeGreaterThan(before)
    expect(after.last_event_seq).toBe(42)
  })

  it('intervals are sane defaults', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0)
    expect(STALE_HEARTBEAT_MS).toBeGreaterThan(HEARTBEAT_INTERVAL_MS)
  })
})

describe('markRunningSessionsAbandonedSync (graceful shutdown)', () => {
  beforeEach(() => {
    const root = path.join(TMP_ROOT, 'sessions')
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('tags running sessions as abandoned with graceful_shutdown reason', () => {
    const id = 's-sigterm'
    freshSession(id)
    appendSessionEvent({
      sessionId: id, seq: 0, ts: Date.now() / 1000, kind: 'tool_called',
      depth: 0, nodeId: null, toolCallId: 'tc', toolName: 'web-search', data: {},
    })
    // event-writer is async; write the line directly so reconciliation sees it.
    writeEventLine(id, {
      seq: 0, ts: Date.now() / 1000, kind: 'tool_called', depth: 0,
      node_id: null, tool_call_id: 'tc', tool_name: 'web-search', data_json: '{}',
    })

    const n = markRunningSessionsAbandonedSync()
    expect(n).toBeGreaterThanOrEqual(1)
    const meta = getSession(id)
    expect(meta?.status).toBe('abandoned')
    expect(meta?.abandoned_reason?.kind).toBe('graceful_shutdown_during_turn')
    expect(meta?.abandoned_reason?.last_event_kind).toBe('tool_called')
  })

  it('does NOT touch needs_input sessions (still resumable via answer)', () => {
    const id = 's-needs'
    freshSession(id)
    updateMeta(id, { status: 'needs_input' })
    markRunningSessionsAbandonedSync()
    const meta = getSession(id)
    expect(meta?.status).toBe('needs_input')
  })

  it('does NOT touch idle sessions', () => {
    const id = 's-idle'
    freshSession(id)
    updateMeta(id, { status: 'idle' })
    markRunningSessionsAbandonedSync()
    const meta = getSession(id)
    expect(meta?.status).toBe('idle')
  })
})
