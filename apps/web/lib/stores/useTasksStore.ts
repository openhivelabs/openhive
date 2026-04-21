import { create } from 'zustand'
import {
  type AskUserQuestion,
  type RunEvent,
  attachRun,
  startRun,
  stopBackendRun,
} from '../api/runs'
import { deleteTask as apiDeleteTask, fetchTasks, saveTask as apiSaveTask } from '../api/tasks'
import { t as translate } from '../i18n'
import { mockTasks } from '../mock/tasks'
import type { Message, PendingAsk, Task, TaskRun, TaskStatus, Team } from '../types'
import { useAppStore } from './useAppStore'
import { useCanvasStore } from './useCanvasStore'
import { useDrawerStore } from './useDrawerStore'

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

/** Build the actual prompt sent to the engine: task prompt + inlined reference files. */
function composePrompt(task: Task): string {
  if (!task.references || task.references.length === 0) return task.prompt
  const parts: string[] = [task.prompt, '', '--- Reference materials ---']
  for (const ref of task.references) {
    parts.push('', `[file: ${ref.name}]`)
    if (ref.note && ref.note.trim()) {
      parts.push(`note: ${ref.note.trim()}`)
    }
    if (ref.kind === 'text' && ref.content) {
      parts.push(ref.content)
    } else {
      parts.push(`(binary, ${ref.size} bytes — not inlined)`)
    }
  }
  return parts.join('\n')
}

export function taskStatus(task: Task): TaskStatus {
  if (task.runs.length === 0) {
    return task.mode === 'scheduled' ? 'scheduled' : 'draft'
  }
  // Concurrency: a task can have multiple live runs (user hits Play twice, or
  // cron fires while a manual run is mid-flight). Prioritise active states
  // across ALL runs rather than defaulting to `runs[last]`, otherwise a fresh
  // short-lived run (e.g. a cancellation) can mask an older run that's still
  // waiting on the user.
  const hasPendingAsk = task.runs.some(
    (r) => r.status === 'running' && r.pendingAsk,
  )
  if (hasPendingAsk) return 'needs_input'
  if (task.runs.some((r) => r.status === 'needs_input')) return 'needs_input'
  if (task.runs.some((r) => r.status === 'running')) return 'running'
  const latest = task.runs[task.runs.length - 1]!
  if (latest.status === 'failed') return 'failed'
  // done — cron tasks loop back to scheduled after a successful run
  return task.mode === 'scheduled' ? 'scheduled' : 'done'
}

// ─── Persistence (debounced fire-and-forget) ─────────────────────────────────
// Streaming token updates can fire dozens of times per second. We don't want to
// hammer the server, so per-task we coalesce writes onto a single trailing flush.
const PERSIST_DEBOUNCE_MS = 800
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

function schedulePersist(getTask: () => Task | undefined, taskId: string) {
  const existing = pendingTimers.get(taskId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    pendingTimers.delete(taskId)
    const task = getTask()
    if (!task) return
    apiSaveTask(task).catch((e) => {
      console.warn(`[tasks] persist failed for ${taskId}`, e)
    })
  }, PERSIST_DEBOUNCE_MS)
  pendingTimers.set(taskId, timer)
}

/** Force an immediate flush (used for status transitions where we don't want to wait). */
function persistNow(task: Task) {
  const existing = pendingTimers.get(task.id)
  if (existing) {
    clearTimeout(existing)
    pendingTimers.delete(task.id)
  }
  apiSaveTask(task).catch((e) => {
    console.warn(`[tasks] persist failed for ${task.id}`, e)
  })
}

interface TasksState {
  tasks: Task[]
  selectedTaskId: string | null
  hydrated: boolean

  hydrate: () => Promise<void>

  addTask: (t: Task) => void
  removeTask: (id: string) => void
  updateTask: (id: string, patch: Partial<Task>) => void
  selectTask: (id: string | null) => void

  addRun: (taskId: string, run: TaskRun) => void
  updateRun: (taskId: string, runId: string, patch: Partial<TaskRun>) => void
  markRunViewed: (taskId: string, runId: string) => void
  addRunMessage: (taskId: string, runId: string, msg: Message) => void
  updateRunMessage: (
    taskId: string,
    runId: string,
    msgId: string,
    patch: Partial<Message>,
  ) => void

  /** Run a task via the streaming engine. Creates a new TaskRun and drives events. */
  runTaskNow: (task: Task, team: Team) => Promise<void>
  /** Reconnect to any in-flight backend runs (survives reload/navigation). */
  reattachRuns: (team: Team) => void
  /** Abort an active run. Safe to call when no run is active (no-op). */
  stopRun: (runId: string) => void
}

/** Shared event-stream consumer — used both by a fresh `runTaskNow` (after
 *  POSTing /start) and by `reattachRuns` (after reload / navigation). The
 *  backend owns the run lifetime now; this function just renders its events
 *  into the local TaskRun. Re-attach is idempotent because the server replays
 *  every persisted event before tailing live ones. */
async function consumeRunStream(
  get: () => TasksState,
  _set: (partial: Partial<TasksState> | ((s: TasksState) => Partial<TasksState>)) => void,
  task: Task,
  team: Team,
  runId: string,
  backendRunId: string,
) {
  const setActiveAgents = useCanvasStore.getState().setActiveAgents
  const setActiveEdges = useCanvasStore.getState().setActiveEdges

  const bubbleByNode: Record<string, string> = {}
  const outputByNode: Record<string, string> = {}
  const activeNodes = new Set<string>()
  const activeEdges = new Set<string>()

  const ensureBubble = (nodeId: string): string => {
    const existing = bubbleByNode[nodeId]
    if (existing) return existing
    const bubbleId = makeId('m')
    bubbleByNode[nodeId] = bubbleId
    outputByNode[nodeId] = ''
    get().addRunMessage(task.id, runId, {
      id: bubbleId,
      teamId: task.teamId,
      from: nodeId,
      text: '',
      createdAt: new Date().toISOString(),
    })
    return bubbleId
  }

  const pushSystem = (text: string) => {
    get().addRunMessage(task.id, runId, {
      id: makeId('m'),
      teamId: task.teamId,
      from: 'system',
      text,
      createdAt: new Date().toISOString(),
    })
  }

  const abort = new AbortController()
  activeAborts.set(runId, abort)
  let sawTerminal = false
  try {
    const iter = attachRun(backendRunId, { signal: abort.signal })
    for (;;) {
      const step = await iter.next()
      if (step.done) break
      const ev: RunEvent = step.value
      switch (ev.kind) {
        case 'node_started':
          if (ev.node_id) {
            activeNodes.add(ev.node_id)
            setActiveAgents(Array.from(activeNodes))
          }
          break
        case 'node_finished':
          if (ev.node_id) {
            activeNodes.delete(ev.node_id)
            setActiveAgents(Array.from(activeNodes))
          }
          break
        case 'token': {
          if (!ev.node_id) break
          const bubbleId = ensureBubble(ev.node_id)
          const delta = String((ev.data as { text?: string }).text ?? '')
          outputByNode[ev.node_id] = (outputByNode[ev.node_id] ?? '') + delta
          get().updateRunMessage(task.id, runId, bubbleId, {
            text: outputByNode[ev.node_id],
          })
          break
        }
        case 'tool_result':
          if (ev.node_id) delete bubbleByNode[ev.node_id]
          break
        case 'delegation_opened': {
          const assigneeId = String((ev.data as Record<string, unknown>).assignee_id ?? '')
          const assigneeRole = String((ev.data as Record<string, unknown>).assignee_role ?? '')
          const taskText = String((ev.data as Record<string, unknown>).task ?? '')
          if (ev.node_id && assigneeId) {
            for (const e of team.edges) {
              if (e.source === ev.node_id && e.target === assigneeId) activeEdges.add(e.id)
            }
            setActiveEdges(Array.from(activeEdges))
          }
          pushSystem(
            translate(useAppStore.getState().locale, 'trace.delegateOpen', {
              role: assigneeRole,
              task: taskText,
            }),
          )
          break
        }
        case 'delegation_closed': {
          const assigneeId = String((ev.data as Record<string, unknown>).assignee_id ?? '')
          const assigneeRole = String((ev.data as Record<string, unknown>).assignee_role ?? '')
          const isError = Boolean((ev.data as Record<string, unknown>).error)
          if (ev.node_id && assigneeId) {
            for (const e of team.edges) {
              if (e.source === ev.node_id && e.target === assigneeId) activeEdges.delete(e.id)
            }
            setActiveEdges(Array.from(activeEdges))
          }
          pushSystem(
            translate(
              useAppStore.getState().locale,
              isError ? 'trace.delegateCloseErr' : 'trace.delegateCloseOk',
              { role: assigneeRole },
            ),
          )
          break
        }
        case 'tool_called':
          if (ev.tool_name && ev.tool_name !== 'delegate_to') {
            pushSystem(
              translate(useAppStore.getState().locale, 'trace.toolCall', {
                name: ev.tool_name,
              }),
            )
          }
          break
        case 'user_question': {
          const qs = ((ev.data as Record<string, unknown>).questions as AskUserQuestion[]) ?? []
          const agentRole = String((ev.data as Record<string, unknown>).agent_role ?? '')
          if (ev.tool_call_id && qs.length > 0) {
            const pending: PendingAsk = {
              toolCallId: ev.tool_call_id,
              questions: qs,
              agentRole: agentRole || undefined,
            }
            get().updateRun(task.id, runId, { pendingAsk: pending })
            pushSystem(
              translate(useAppStore.getState().locale, 'trace.askOpen', {
                role: agentRole || 'agent',
                count: qs.length,
              }),
            )
          }
          break
        }
        case 'user_answered':
          get().updateRun(task.id, runId, { pendingAsk: undefined })
          pushSystem(
            translate(
              useAppStore.getState().locale,
              Boolean((ev.data as Record<string, unknown>).skipped)
                ? 'trace.askSkipped'
                : 'trace.askAnswered',
            ),
          )
          break
        case 'run_error':
          pushSystem(
            translate(useAppStore.getState().locale, 'trace.runError', {
              error: String((ev.data as Record<string, unknown>).error ?? 'run failed'),
            }),
          )
          get().updateRun(task.id, runId, {
            status: 'failed',
            endedAt: new Date().toISOString(),
            error: String((ev.data as Record<string, unknown>).error ?? 'run failed'),
          })
          sawTerminal = true
          break
        case 'run_finished':
          sawTerminal = true
          break
      }
    }
    // Stream closed. Only mark `done` if the server actually told us the run
    // finished — otherwise this could be a page refresh / network blip on a
    // still-live run, and the next reattach will sync the real status. The
    // old code marked done unconditionally, which flipped interrupted runs
    // to "done" on refresh.
    if (sawTerminal) {
      const current = get().tasks.find((t) => t.id === task.id)
      const cr = current?.runs.find((r) => r.id === runId)
      if (cr && cr.status === 'running') {
        get().updateRun(task.id, runId, {
          status: 'done',
          endedAt: new Date().toISOString(),
        })
      }
    }
  } catch (e) {
    const aborted = abort.signal.aborted
    if (aborted) {
      // Stopped by user / navigated / unmounted — leave backend state alone.
      // The backend run keeps going; a later reattach will sync up.
      return
    }
    // Network errors (browser navigation killing fetch, SSE disconnects, HMR
    // reloads) must NOT demote the run to failed — they routinely happen on
    // page refreshes while the engine is fine server-side. Only status events
    // from the server itself can move a run to a terminal state.
    // Intentionally leaves the run as-is; the next reattach replays state.
    return
  } finally {
    activeAborts.delete(runId)
    setActiveAgents([])
    setActiveEdges([])
    void useDrawerStore.getState().refreshTeamArtifacts(team.id)
  }
}

// runId -> AbortController for currently-streaming runs. Lives outside the store so
// AbortController instances aren't part of the serialized state.
const activeAborts = new Map<string, AbortController>()

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    try {
      const fromServer = await fetchTasks()
      if (fromServer.length > 0) {
        // Legacy healing: only runs that predate the persistent-run refactor
        // (no backendRunId) are truly orphaned on reload — the old engine
        // coupled the stream lifetime to the client. Modern runs keep going
        // server-side regardless, so we leave those as 'running' and let
        // reattachRuns() reconnect when the team is loaded.
        const now = new Date().toISOString()
        const healed = fromServer.map((t) => {
          let touched = false
          const runs = t.runs.map((r) => {
            if (r.status === 'running' && !r.endedAt && !r.backendRunId) {
              touched = true
              return { ...r, status: 'failed' as const, endedAt: now, error: 'interrupted' }
            }
            return r
          })
          if (touched) persistNow({ ...t, runs })
          return touched ? { ...t, runs } : t
        })
        set({ tasks: healed, hydrated: true })
        return
      }
      // First boot: seed mock data so the UI isn't blank, and persist it.
      set({ tasks: mockTasks, hydrated: true })
      for (const t of mockTasks) {
        apiSaveTask(t).catch((e) => console.warn('[tasks] seed save failed', e))
      }
    } catch (e) {
      console.error('[tasks] hydrate failed; using mock data in-memory', e)
      set({ tasks: mockTasks, hydrated: true })
    }
  },

  addTask: (t) => {
    set((s) => ({ tasks: [...s.tasks, t] }))
    persistNow(t)
  },

  removeTask: (id) => {
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      selectedTaskId: s.selectedTaskId === id ? null : s.selectedTaskId,
    }))
    const timer = pendingTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      pendingTimers.delete(id)
    }
    apiDeleteTask(id).catch((e) => console.warn(`[tasks] delete failed for ${id}`, e))
  },

  updateTask: (id, patch) => {
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }))
    schedulePersist(() => get().tasks.find((t) => t.id === id), id)
  },

  selectTask: (id) => set({ selectedTaskId: id }),

  markRunViewed: (taskId, runId) => {
    const now = new Date().toISOString()
    let changed = false
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id !== taskId) return t
        const runs = t.runs.map((r) => {
          if (r.id !== runId || r.viewedAt) return r
          changed = true
          return { ...r, viewedAt: now }
        })
        return changed ? { ...t, runs } : t
      }),
    }))
    if (changed) {
      schedulePersist(() => get().tasks.find((t) => t.id === taskId), taskId)
    }
  },

  addRun: (taskId, run) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, runs: [...t.runs, run] } : t,
      ),
    }))
    schedulePersist(() => get().tasks.find((t) => t.id === taskId), taskId)
  },

  updateRun: (taskId, runId, patch) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              runs: t.runs.map((r) => (r.id === runId ? { ...r, ...patch } : r)),
            }
          : t,
      ),
    }))
    // Status transitions (running→done/failed, pendingAsk changes) deserve an
    // immediate flush — that's what users expect to survive a refresh.
    const task = get().tasks.find((t) => t.id === taskId)
    if (task && (patch.status || 'pendingAsk' in patch)) {
      persistNow(task)
    } else {
      schedulePersist(() => get().tasks.find((t) => t.id === taskId), taskId)
    }
  },

  addRunMessage: (taskId, runId, msg) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              runs: t.runs.map((r) =>
                r.id === runId ? { ...r, messages: [...r.messages, msg] } : r,
              ),
            }
          : t,
      ),
    }))
    schedulePersist(() => get().tasks.find((t) => t.id === taskId), taskId)
  },

  updateRunMessage: (taskId, runId, msgId, patch) => {
    // Fires on every streamed token — can be dozens per second. We keep it
    // in-memory only; the authoritative event log lives in the backend's
    // `run_events` table, and the terminal `updateRun({status:'done'})`
    // call will persist the final assembled task with the completed message.
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              runs: t.runs.map((r) =>
                r.id === runId
                  ? {
                      ...r,
                      messages: r.messages.map((m) =>
                        m.id === msgId ? { ...m, ...patch } : m,
                      ),
                    }
                  : r,
              ),
            }
          : t,
      ),
    }))
  },

  runTaskNow: async (task, team) => {
    const fullPrompt = composePrompt(task)
    const runId = makeId('run')
    const run: TaskRun = {
      id: runId,
      taskId: task.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      messages: [],
    }
    get().addRun(task.id, run)
    let backendRunId: string
    try {
      backendRunId = await startRun(team, fullPrompt, {
        locale: useAppStore.getState().locale,
      })
    } catch (e) {
      get().updateRun(task.id, runId, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      })
      return
    }
    get().updateRun(task.id, runId, { backendRunId })
    await consumeRunStream(get, set, task, team, runId, backendRunId)
  },

  reattachRuns: (team) => {
    // For every task in this team whose latest run is still "running" and has
    // a backend run id, attach a new stream. No-op if an attach is already
    // live (identified by an entry in activeAborts).
    for (const t of get().tasks) {
      if (t.teamId !== team.id) continue
      const run = t.runs[t.runs.length - 1]
      if (!run) continue
      if (run.status !== 'running' || !run.backendRunId) continue
      if (activeAborts.has(run.id)) continue
      void consumeRunStream(get, set, t, team, run.id, run.backendRunId)
    }
  },

  stopRun: (runId) => {
    // Always tell the backend to stop its run too — the in-browser
    // AbortController only closes OUR attached stream; the engine keeps
    // executing unless we explicitly cancel it server-side.
    let backendRunId: string | undefined
    for (const t of get().tasks) {
      const r = t.runs.find((x) => x.id === runId)
      if (r) {
        backendRunId = r.backendRunId
        break
      }
    }
    const ctrl = activeAborts.get(runId)
    if (ctrl) ctrl.abort()
    if (backendRunId) void stopBackendRun(backendRunId)

    // If no live attach owned this (reload / navigated tab), there's nothing
    // local to unwind — force the row to failed so the UI is honest.
    if (!ctrl) {
      const now = new Date().toISOString()
      let ownerTaskId: string | null = null
      set((s) => ({
        tasks: s.tasks.map((t) => {
          if (!t.runs.some((r) => r.id === runId)) return t
          ownerTaskId = t.id
          return {
            ...t,
            runs: t.runs.map((r) =>
              r.id === runId && r.status === 'running'
                ? { ...r, status: 'failed' as const, endedAt: now, error: 'stopped by user' }
                : r,
            ),
          }
        }),
      }))
      if (ownerTaskId) schedulePersist(() => get().tasks.find((t) => t.id === ownerTaskId), ownerTaskId)
    }
  },
}))
