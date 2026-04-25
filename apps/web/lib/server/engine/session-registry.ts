/**
 * Live-session registry: decouples engine execution from SSE client lifecycle.
 *
 * A session is driven as a background async task. Clients attach via SSE to
 * receive events; detach/refresh/close doesn't affect the session. Multiple
 * clients can watch the same session. The session only ends when the engine does
 * (success / error / explicit stop). Every event is persisted to session_events
 * as it fires so late attachers can replay history.
 *
 * All state is in-process and cached on globalThis to survive Next.js HMR.
 */

import { clearCodexChain } from '../providers/codex'
import * as sessionsStore from '../sessions'
import { closeUserInbox, runTeam } from './session'
import { generateTitle } from '../sessions/title'
import type { Event } from '../events/schema'
import type { TeamSpec } from './team'
import type { ChatMessage } from '../providers/types'

/** Sentinel pushed into a listener queue when the run is over. */
const END = Symbol('session-end')
type Envelope = Event | typeof END

export interface SessionHandle {
  sessionId: string
  events: Event[]
  /** seq number of the FIRST event this run will emit. 0 for fresh starts;
   *  the on-disk events.jsonl line count for resumes. Lets `liveEventsFor`
   *  assign canonical seq numbers to in-memory events without consulting
   *  the event-writer (which is async). */
  seqStart: number
  listeners: Set<AsyncPushQueue<Envelope>>
  finished: boolean
  /** Set when the caller wants to cancel the run. */
  abort: AbortController
}

interface RegistryState {
  active: Map<string, SessionHandle>
}

const globalForRegistry = globalThis as unknown as {
  __openhive_session_registry?: RegistryState
}

function state(): RegistryState {
  if (!globalForRegistry.__openhive_session_registry) {
    globalForRegistry.__openhive_session_registry = { active: new Map() }
  }
  return globalForRegistry.__openhive_session_registry
}

export function getHandle(sessionId: string): SessionHandle | null {
  return state().active.get(sessionId) ?? null
}

export function isActive(sessionId: string): boolean {
  return state().active.has(sessionId)
}

/** Forcibly evict a handle from the registry. Used when the stream handler
 *  detects a zombie (registry says active but no event in a long time —
 *  engine generator died from HMR or an uncaught rejection). After this,
 *  `isActive()` flips to false so the replay/reconcile path takes over. */
export function forceEvict(sessionId: string): void {
  const h = state().active.get(sessionId)
  if (!h) return
  h.finished = true
  for (const q of h.listeners) q.push(END)
  state().active.delete(sessionId)
}

/** Attach to a session: snapshot past events + subscribe to future ones.
 *  `detach()` removes the listener queue from the handle so it stops receiving
 *  pushes — callers MUST invoke it when their consumer goes away (client
 *  disconnect, error, etc.), otherwise event buffers leak memory for every
 *  browser tab that ever connected. */
export function attach(sessionId: string): {
  snapshot: Event[]
  queue: AsyncPushQueue<Envelope>
  detach: () => void
} | null {
  const h = getHandle(sessionId)
  if (!h) return null
  const q = new AsyncPushQueue<Envelope>()
  const snapshot = [...h.events]
  if (h.finished) {
    q.push(END)
    return { snapshot, queue: q, detach: () => {} }
  }
  h.listeners.add(q)
  const detach = () => {
    h.listeners.delete(q)
    // Wake any pending pop so the consumer's loop can finish.
    q.push(END)
  }
  return { snapshot, queue: q, detach }
}

export async function stop(sessionId: string): Promise<boolean> {
  const h = getHandle(sessionId)
  if (!h || h.finished) return false
  h.abort.abort()
  // The chat loop may be parked on the user-message inbox — wake it so the
  // generator observes the abort and exits.
  closeUserInbox(sessionId)
  // Eager terminal meta write. Without this, the engine generator throws on
  // abort and never emits `run_finished` / `turn_finished`, so meta.status
  // stays 'running' forever — the FE keeps subscribing to the dead SSE and
  // freezes when the user navigates. By the time /stop returns 200, status
  // is guaranteed terminal so the FE can move on. The boot-time
  // reclassifier still owns the hard-crash recovery path; this just covers
  // the explicit-cancel path that abort() short-circuits past.
  const now = Date.now()
  sessionsStore.updateMeta(sessionId, {
    status: 'abandoned',
    finished_at: now,
    abandoned_reason: {
      kind: 'cancelled_by_user',
      last_event_seq: null,
      last_event_kind: null,
      last_event_ts: null,
      detected_at: now,
    },
    error: 'cancelled',
  })
  return true
}

/** Launch the engine in the background. Resolves with the engine-assigned
 *  session_id once the first event has been emitted. */
export async function start(
  team: TeamSpec,
  goal: string,
  teamSlugs: [string, string] | null,
  locale: string,
  taskId: string | null = null,
): Promise<string> {
  let ready: (sessionId: string) => void = () => {}
  let readyErr: (err: unknown) => void = () => {}
  const readyPromise = new Promise<string>((resolve, reject) => {
    ready = resolve
    readyErr = reject
  })

  const handle: SessionHandle = {
    sessionId: '',
    events: [],
    seqStart: 0,
    listeners: new Set(),
    finished: false,
    abort: new AbortController(),
  }

  void driveSession(handle, team, goal, teamSlugs, locale, taskId, null, ready, readyErr)
  return readyPromise
}

/** Re-enter a parked session with a new user message. Rebuilds the Lead's
 *  chat history from events.jsonl, then drives a fresh engine run that emits
 *  `user_message` (for the follow-up) and replies. Returns true if the
 *  session existed on disk and a new handle was registered. */
export async function resume(
  team: TeamSpec,
  sessionId: string,
  text: string,
  teamSlugs: [string, string] | null,
  locale: string,
): Promise<boolean> {
  if (isActive(sessionId)) {
    // Already live — caller should push onto the inbox instead of spinning up
    // a duplicate generator.
    return false
  }
  const meta = sessionsStore.getSession(sessionId)
  if (!meta) return false
  const history = buildLeadHistoryFromEvents(sessionId, meta.goal)

  const handle: SessionHandle = {
    sessionId,
    events: [],
    seqStart: sessionsStore.eventsForSession(sessionId).length,
    listeners: new Set(),
    finished: false,
    abort: new AbortController(),
  }
  let ready: (sessionId: string) => void = () => {}
  let readyErr: (err: unknown) => void = () => {}
  const readyPromise = new Promise<string>((resolve, reject) => {
    ready = resolve
    readyErr = reject
  })
  void driveSession(
    handle,
    team,
    text,
    teamSlugs,
    locale,
    meta.task_id,
    { sessionId, history },
    ready,
    readyErr,
  )
  await readyPromise
  return true
}

/** Rebuild the Lead's chat history from the persisted event log so a resumed
 *  generator sees the conversation as if it never stopped. Collapses the
 *  transcript to alternating user/assistant turns; intermediate tool calls
 *  and sub-agent work are deliberately dropped — the Lead only needs
 *  conversational context, the details are already in events.jsonl for the
 *  UI to render. */
function buildLeadHistoryFromEvents(
  sessionId: string,
  initialGoal: string,
): ChatMessage[] {
  const events = sessionsStore.eventsForSession(sessionId)
  const history: ChatMessage[] = [{ role: 'user', content: initialGoal }]
  for (const ev of events) {
    if (ev.kind === 'user_message') {
      const text = typeof ev.data.text === 'string' ? ev.data.text : ''
      if (text) history.push({ role: 'user', content: text })
    } else if (ev.kind === 'node_finished' && ev.depth === 0) {
      const out = typeof ev.data.output === 'string' ? ev.data.output : ''
      if (out.trim()) history.push({ role: 'assistant', content: out })
    }
  }
  return history
}

async function driveSession(
  handle: SessionHandle,
  team: TeamSpec,
  goal: string,
  teamSlugs: [string, string] | null,
  locale: string,
  taskId: string | null,
  resume: { sessionId: string; history: ChatMessage[] } | null,
  ready: (sessionId: string) => void,
  readyErr: (err: unknown) => void,
): Promise<void> {
  // Start at seq=current events count when resuming so appendSessionEvent
  // keeps monotonic ordering across sessions that span multiple processes.
  // Also pin handle.seqStart so liveEventsFor can synthesize seq numbers
  // for in-memory events without racing the async event-writer.
  let seq = resume
    ? sessionsStore.eventsForSession(resume.sessionId).length
    : 0
  handle.seqStart = seq
  let capturedSessionId: string | null = null
  // On resume the on-disk meta already exists — skip the fresh startSession
  // + auto-title work. On cold start, run_started triggers both.
  let dbStarted = !!resume

  // Periodic heartbeat — refreshes meta.last_alive_at while a turn is in
  // flight so boot reconciliation can tell apart a clean idle session from
  // one whose owning process was killed mid-run. Cheap (meta.json rewrite,
  // no event-log line). Started on the first event we observe; cleared in
  // the finally block.
  let heartbeatTimer: NodeJS.Timeout | null = null
  const startHeartbeat = (sid: string) => {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(() => {
      try {
        sessionsStore.touchHeartbeat(sid, seq - 1)
      } catch {
        /* best-effort — next tick will retry */
      }
    }, sessionsStore.HEARTBEAT_INTERVAL_MS)
    heartbeatTimer.unref?.()
  }

  try {
    for await (const event of runTeam(team, goal, { teamSlugs, locale, resume: resume ?? undefined })) {
      if (handle.abort.signal.aborted) {
        if (capturedSessionId && dbStarted) {
          await sessionsStore.finishSession(capturedSessionId, { error: 'cancelled' })
        }
        return
      }

      if (capturedSessionId === null) {
        capturedSessionId = event.session_id
        handle.sessionId = capturedSessionId
        state().active.set(capturedSessionId, handle)
        ready(capturedSessionId)
        startHeartbeat(capturedSessionId)
      }

      if (event.kind === 'run_started' && !dbStarted) {
        sessionsStore.startSession(event.session_id, team.id, goal, taskId, team)
        dbStarted = true
        // Fire-and-forget auto-title generation. Must not block the run, must
        // not throw, and only writes meta.title on success.
        const sid = event.session_id
        const titleLocale = locale === 'ko' ? 'ko' : 'en'
        void generateTitle(goal, titleLocale)
          .then((t) => {
            if (t) sessionsStore.updateMetaTitle(sid, t)
          })
          .catch(() => { /* swallow — title is best-effort */ })
      }

      sessionsStore.appendSessionEvent({
        sessionId: event.session_id,
        seq,
        ts: event.ts,
        kind: event.kind,
        depth: event.depth,
        nodeId: event.node_id,
        toolCallId: event.tool_call_id,
        toolName: event.tool_name,
        data: event.data,
      })
      seq += 1

      handle.events.push(event)
      for (const q of handle.listeners) q.push(event)

      if (event.kind === 'run_finished') {
        // Chat sessions rarely hit this — runTeamBody only emits run_finished
        // when the inbox is closed (explicit stop). Treat as idle-with-output:
        // keep the session resumable unless the user deleted it.
        const output =
          typeof event.data.output === 'string'
            ? (event.data.output as string)
            : null
        sessionsStore.updateMeta(event.session_id, {
          status: 'idle',
          output,
          finished_at: Date.now(),
        })
      } else if (event.kind === 'run_error') {
        const err = String(event.data.error ?? 'error')
        await sessionsStore.finishSession(event.session_id, { error: err })
      } else if (event.kind === 'turn_finished') {
        // Turn done, generator parks on inbox.pop. UI stops spinning; the
        // session is now resumable via a follow-up POST /messages.
        const output =
          typeof event.data.output === 'string'
            ? (event.data.output as string)
            : null
        sessionsStore.updateMeta(event.session_id, {
          status: 'idle',
          output,
          finished_at: Date.now(),
        })
      } else if (event.kind === 'user_message') {
        // New turn starts — flip idle → running.
        sessionsStore.updateMeta(event.session_id, {
          status: 'running',
          finished_at: null,
        })
      } else if (event.kind === 'user_question') {
        // Engine is parked on an ask_user tool call. Status must reflect
        // that the user has a blocker, not just "running" — otherwise the
        // inbox won't keep the row in "needs answer" after a page reload.
        sessionsStore.updateMeta(event.session_id, {
          status: 'needs_input',
        })
      } else if (event.kind === 'user_answered') {
        // Answer (or skip) delivered — engine resumes token generation.
        sessionsStore.updateMeta(event.session_id, {
          status: 'running',
        })
      }
    }
  } catch (exc) {
    if (capturedSessionId && dbStarted) {
      const err = exc instanceof Error ? exc.message : String(exc)
      await sessionsStore.finishSession(capturedSessionId, { error: err })
    }
    if (!capturedSessionId) {
      readyErr(exc)
      return
    }
  } finally {
    handle.finished = true
    for (const q of handle.listeners) q.push(END)
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (capturedSessionId) {
      state().active.delete(capturedSessionId)
      // Drop any Codex `previous_response_id` chain head left from the
      // last turn — this session is done, and letting the map grow
      // unbounded would leak one string per session across the process
      // lifetime. Safe to call for sessions that never used Codex.
      clearCodexChain(capturedSessionId)
    }
    if (!handle.sessionId) {
      readyErr(new Error('engine exited before emitting any event'))
    }
  }
}

// -------- async push queue --------

class AsyncPushQueue<T> {
  private buffer: T[] = []
  private waiters: Array<(value: T) => void> = []

  push(value: T): void {
    const w = this.waiters.shift()
    if (w) w(value)
    else this.buffer.push(value)
  }

  async pop(): Promise<T> {
    if (this.buffer.length > 0) return this.buffer.shift()!
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

export { AsyncPushQueue, END }

/** Return events for a session, preferring in-memory state when active.
 *
 *  Background: the event-writer batches disk writes (~100ms / 10 events).
 *  Reading events.jsonl directly during an active run can lag the in-memory
 *  truth by a full flush window — that's the root of the "must refresh to
 *  see updates" UI bug. This helper merges the on-disk prefix (anything
 *  emitted in earlier process lifetimes / runs) with the live in-memory
 *  ring (`handle.events`), assigning canonical seq numbers from the run's
 *  pinned `seqStart`.
 *
 *  When the session is idle / unknown, falls back to disk read. */
export function liveEventsFor(sessionId: string): sessionsStore.StoredEventRow[] {
  const handle = state().active.get(sessionId)
  if (!handle) return sessionsStore.eventsForSession(sessionId)
  const seqStart = handle.seqStart
  const prefix =
    seqStart > 0
      ? sessionsStore.eventsForSession(sessionId).filter((r) => r.seq < seqStart)
      : []
  const live: sessionsStore.StoredEventRow[] = handle.events.map((e, i) => ({
    seq: seqStart + i,
    ts: e.ts,
    kind: e.kind,
    depth: e.depth,
    node_id: e.node_id,
    tool_call_id: e.tool_call_id,
    tool_name: e.tool_name,
    data: e.data,
  }))
  return prefix.concat(live)
}
