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

import * as sessionsStore from '../sessions'
import { runTeam } from './session'
import type { Event } from '../events/schema'
import type { TeamSpec } from './team'

/** Sentinel pushed into a listener queue when the run is over. */
const END = Symbol('session-end')
type Envelope = Event | typeof END

export interface SessionHandle {
  sessionId: string
  events: Event[]
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
    listeners: new Set(),
    finished: false,
    abort: new AbortController(),
  }

  void driveSession(handle, team, goal, teamSlugs, locale, taskId, ready, readyErr)
  return readyPromise
}

async function driveSession(
  handle: SessionHandle,
  team: TeamSpec,
  goal: string,
  teamSlugs: [string, string] | null,
  locale: string,
  taskId: string | null,
  ready: (sessionId: string) => void,
  readyErr: (err: unknown) => void,
): Promise<void> {
  let seq = 0
  let capturedSessionId: string | null = null
  let dbStarted = false

  try {
    for await (const event of runTeam(team, goal, { teamSlugs, locale })) {
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
      }

      if (event.kind === 'run_started' && !dbStarted) {
        sessionsStore.startSession(event.session_id, team.id, goal, taskId)
        dbStarted = true
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
        const output =
          typeof event.data.output === 'string'
            ? (event.data.output as string)
            : null
        await sessionsStore.finishSession(event.session_id, { output })
      } else if (event.kind === 'run_error') {
        const err = String(event.data.error ?? 'error')
        await sessionsStore.finishSession(event.session_id, { error: err })
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
    if (capturedSessionId) state().active.delete(capturedSessionId)
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
