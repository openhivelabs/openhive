/**
 * Live-run registry: decouples engine execution from SSE client lifecycle.
 * Ports apps/server/openhive/engine/run_registry.py.
 *
 * A run is driven as a background async task. Clients attach via SSE to
 * receive events; detach/refresh/close doesn't affect the run. Multiple
 * clients can watch the same run. The run only ends when the engine does
 * (success / error / explicit stop). Every event is persisted to run_events
 * as it fires so late attachers can replay history.
 *
 * All state is in-process and cached on globalThis to survive Next.js HMR.
 */

import * as runsStore from '../runs-store'
import { runTeam } from './run'
import type { Event } from '../events/schema'
import type { TeamSpec } from './team'

/** Sentinel pushed into a listener queue when the run is over. */
const END = Symbol('run-end')
type Envelope = Event | typeof END

interface RunHandle {
  runId: string
  events: Event[]
  listeners: Set<AsyncPushQueue<Envelope>>
  finished: boolean
  /** Set when the caller wants to cancel the run. */
  abort: AbortController
}

interface RegistryState {
  active: Map<string, RunHandle>
}

const globalForRegistry = globalThis as unknown as {
  __openhive_run_registry?: RegistryState
}

function state(): RegistryState {
  if (!globalForRegistry.__openhive_run_registry) {
    globalForRegistry.__openhive_run_registry = { active: new Map() }
  }
  return globalForRegistry.__openhive_run_registry
}

export function getHandle(runId: string): RunHandle | null {
  return state().active.get(runId) ?? null
}

export function isActive(runId: string): boolean {
  return state().active.has(runId)
}

/** Attach to a run: snapshot past events + subscribe to future ones. */
export function attach(runId: string): {
  snapshot: Event[]
  queue: AsyncPushQueue<Envelope>
} | null {
  const h = getHandle(runId)
  if (!h) return null
  const q = new AsyncPushQueue<Envelope>()
  const snapshot = [...h.events]
  if (h.finished) {
    q.push(END)
  } else {
    h.listeners.add(q)
  }
  return { snapshot, queue: q }
}

export async function stop(runId: string): Promise<boolean> {
  const h = getHandle(runId)
  if (!h || h.finished) return false
  h.abort.abort()
  return true
}

/** Launch the engine in the background. Resolves with the engine-assigned
 *  run_id once the first event has been emitted. */
export async function start(
  team: TeamSpec,
  goal: string,
  teamSlugs: [string, string] | null,
  locale: string,
): Promise<string> {
  let ready: (runId: string) => void = () => {}
  let readyErr: (err: unknown) => void = () => {}
  const readyPromise = new Promise<string>((resolve, reject) => {
    ready = resolve
    readyErr = reject
  })

  const handle: RunHandle = {
    runId: '',
    events: [],
    listeners: new Set(),
    finished: false,
    abort: new AbortController(),
  }

  void driveRun(handle, team, goal, teamSlugs, locale, ready, readyErr)
  return readyPromise
}

async function driveRun(
  handle: RunHandle,
  team: TeamSpec,
  goal: string,
  teamSlugs: [string, string] | null,
  locale: string,
  ready: (runId: string) => void,
  readyErr: (err: unknown) => void,
): Promise<void> {
  let seq = 0
  let capturedRunId: string | null = null
  let dbStarted = false

  try {
    for await (const event of runTeam(team, goal, { teamSlugs, locale })) {
      if (handle.abort.signal.aborted) {
        if (capturedRunId && dbStarted) {
          runsStore.finishRun(capturedRunId, { error: 'cancelled' })
        }
        return
      }

      if (capturedRunId === null) {
        capturedRunId = event.run_id
        handle.runId = capturedRunId
        state().active.set(capturedRunId, handle)
        ready(capturedRunId)
      }

      if (event.kind === 'run_started' && !dbStarted) {
        runsStore.startRun(event.run_id, team.id, goal)
        dbStarted = true
      }

      runsStore.appendRunEvent({
        runId: event.run_id,
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
        runsStore.finishRun(event.run_id, {
          output:
            typeof event.data.output === 'string'
              ? (event.data.output as string)
              : null,
        })
      } else if (event.kind === 'run_error') {
        runsStore.finishRun(event.run_id, {
          error: String(event.data.error ?? 'error'),
        })
      }
    }
  } catch (exc) {
    if (capturedRunId && dbStarted) {
      runsStore.finishRun(capturedRunId, {
        error: exc instanceof Error ? exc.message : String(exc),
      })
    }
    if (!capturedRunId) {
      readyErr(exc)
      return
    }
  } finally {
    handle.finished = true
    for (const q of handle.listeners) q.push(END)
    if (capturedRunId) state().active.delete(capturedRunId)
    if (!handle.runId) {
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
