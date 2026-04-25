import { create } from 'zustand'
import {
  type AskUserQuestion,
  type SessionEvent,
  attachSession,
  stopBackendSession,
} from '../api/sessions'
import { deleteTask as apiDeleteTask, fetchTasks, saveTask as apiSaveTask } from '../api/tasks'
import { t as translate } from '../i18n'
import type { Message, PendingAsk, Session, Task, Team } from '../types'
import { useAppStore } from './useAppStore'
import { useCanvasStore } from './useCanvasStore'
import { useDrawerStore } from './useDrawerStore'
import { useSessionsStore } from './useSessionsStore'

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
  selectedSessionId: string | null
  /** True when the detail modal was opened via the Draft column — meaning
   *  the user wants the bare-bones "about to session" view, not a past-session
   *  summary, even if the task has previous sessions. */
  selectedAsDraft: boolean
  hydrated: boolean

  hydrate: () => Promise<void>

  addTask: (t: Task) => void
  removeTask: (id: string) => void
  updateTask: (id: string, patch: Partial<Task>) => void
  selectTask: (id: string | null) => void
  selectTaskAsDraft: (id: string) => void
  selectRun: (taskId: string, sessionId: string) => void

  addRun: (taskId: string, session: Session) => void
  removeSession: (sessionId: string) => void
  updateRun: (taskId: string, sessionId: string, patch: Partial<Session>) => void
  markRunViewed: (taskId: string, sessionId: string) => void
  addRunMessage: (taskId: string, sessionId: string, msg: Message) => void
  updateRunMessage: (
    taskId: string,
    sessionId: string,
    msgId: string,
    patch: Partial<Message>,
  ) => void

  /** Session a task via the streaming engine. Creates a new Session and drives events. */
  startSessionFromTask: (task: Task, team: Team) => Promise<string | null>
  /** Reconnect to any in-flight backend sessions (survives reload/navigation). */
  reattachSessions: (team: Team) => void
  /** Abort an active session. Safe to call when no session is active (no-op). */
  stopSession: (sessionId: string) => void
}

/** Shared event-stream consumer — used both by a fresh `startSessionFromTask` (after
 *  POSTing /start) and by `reattachSessions` (after reload / navigation). The
 *  backend owns the session lifetime now; this function just renders its events
 *  into the local Session. Re-attach is idempotent because the server replays
 *  every persisted event before tailing live ones. */
async function consumeRunStream(
  get: () => TasksState,
  _set: (partial: Partial<TasksState> | ((s: TasksState) => Partial<TasksState>)) => void,
  task: Task,
  team: Team,
  localSessionId: string,
  backendSessionId: string,
) {
  const syncSession = (patch: Partial<Session>) => {
    useSessionsStore.getState().updateSession(backendSessionId, patch)
  }
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
    get().addRunMessage(task.id, localSessionId, {
      id: bubbleId,
      teamId: task.teamId,
      from: nodeId,
      text: '',
      createdAt: new Date().toISOString(),
    })
    return bubbleId
  }

  const pushSystem = (text: string) => {
    get().addRunMessage(task.id, localSessionId, {
      id: makeId('m'),
      teamId: task.teamId,
      from: 'system',
      text,
      createdAt: new Date().toISOString(),
    })
  }

  const abort = new AbortController()
  activeAborts.set(localSessionId, abort)
  let sawTerminal = false
  try {
    const iter = attachSession(backendSessionId, { signal: abort.signal })
    for (;;) {
      const step = await iter.next()
      if (step.done) break
      const ev: SessionEvent = step.value
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
          get().updateRunMessage(task.id, localSessionId, bubbleId, {
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
            get().updateRun(task.id, localSessionId, { pendingAsk: pending })
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
          get().updateRun(task.id, localSessionId, { pendingAsk: undefined })
          pushSystem(
            translate(
              useAppStore.getState().locale,
              Boolean((ev.data as Record<string, unknown>).skipped)
                ? 'trace.askSkipped'
                : 'trace.askAnswered',
            ),
          )
          break
        case 'run_error': {
          const errMsg = String((ev.data as Record<string, unknown>).error ?? 'session failed')
          pushSystem(
            translate(useAppStore.getState().locale, 'trace.runError', {
              error: errMsg,
            }),
          )
          const endedAt = new Date().toISOString()
          get().updateRun(task.id, localSessionId, {
            status: 'failed',
            endedAt,
            error: errMsg,
          })
          syncSession({
            status: 'failed',
            endedAt,
            error: errMsg,
          })
          sawTerminal = true
          break
        }
        case 'run_finished':
          sawTerminal = true
          break
      }
    }
    // Stream closed. Only mark `done` if the server actually told us the session
    // finished — otherwise this could be a page refresh / network blip on a
    // still-live session, and the next reattach will sync the real status. The
    // old code marked done unconditionally, which flipped interrupted sessions
    // to "done" on refresh.
    if (sawTerminal) {
      const current = get().tasks.find((t) => t.id === task.id)
      const cr = current?.sessions.find((r) => r.id === localSessionId)
      if (cr && cr.status === 'running') {
        const endedAt = new Date().toISOString()
        get().updateRun(task.id, localSessionId, { status: 'done', endedAt })
        syncSession({ status: 'done', endedAt })
      }
    }
  } catch (e) {
    const aborted = abort.signal.aborted
    if (aborted) {
      // Stopped by user / navigated / unmounted — leave backend state alone.
      // The backend session keeps going; a later reattach will sync up.
      return
    }
    if (e instanceof Error && e.message.includes('(404)')) {
      get().removeSession(localSessionId)
      useSessionsStore.getState().removeSession(backendSessionId)
      return
    }
    // Network errors (browser navigation killing fetch, SSE disconnects, HMR
    // reloads) must NOT demote the session to failed — they routinely happen on
    // page refreshes while the engine is fine server-side. Only status events
    // from the server itself can move a session to a terminal state.
    // Intentionally leaves the session as-is; the next reattach replays state.
    return
  } finally {
    activeAborts.delete(localSessionId)
    setActiveAgents([])
    setActiveEdges([])
    void useDrawerStore.getState().refreshTeamArtifacts(team.id)
  }
}

// sessionId -> AbortController for currently-streaming sessions. Lives outside the store so
// AbortController instances aren't part of the serialized state.
const activeAborts = new Map<string, AbortController>()

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  selectedSessionId: null,
  selectedAsDraft: false,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    try {
      const fromServer = await fetchTasks()
      if (fromServer.length > 0) {
        // Legacy healing: only sessions that predate the persistent-session refactor
        // (no sessionId) are truly orphaned on reload — the old engine
        // coupled the stream lifetime to the client. Modern sessions keep going
        // server-side regardless, so we leave those as 'running' and let
        // reattachSessions() reconnect when the team is loaded.
        const now = new Date().toISOString()
        const healed = fromServer.map((t) => {
          let touched = false
          const sessions = t.sessions.map((r) => {
            if (r.status === 'running' && !r.endedAt && !r.id) {
              touched = true
              return { ...r, status: 'failed' as const, endedAt: now, error: 'interrupted' }
            }
            return r
          })
          if (touched) persistNow({ ...t, sessions })
          return touched ? { ...t, sessions } : t
        })
        set({ tasks: healed, hydrated: true })
        return
      }
      // Empty server = genuinely empty. Don't auto-seed mock data — the user
      // starts with a blank inbox and creates what they need. (Previously we
      // seeded `mockTasks` here, which caused wiped state to regrow itself on
      // the next /tasks load.)
      set({ tasks: [], hydrated: true })
    } catch (e) {
      console.error('[tasks] hydrate failed; starting with empty list', e)
      set({ tasks: [], hydrated: true })
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

  selectTask: (id) => set({ selectedTaskId: id, selectedSessionId: null, selectedAsDraft: false }),

  selectTaskAsDraft: (id) => set({ selectedTaskId: id, selectedSessionId: null, selectedAsDraft: true }),

  selectRun: (taskId, sessionId) =>
    set({ selectedTaskId: taskId, selectedSessionId: sessionId, selectedAsDraft: false }),

  markRunViewed: (taskId, sessionId) => {
    const now = new Date().toISOString()
    let changed = false
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id !== taskId) return t
        const sessions = t.sessions.map((r) => {
          if (r.id !== sessionId || r.viewedAt) return r
          changed = true
          return { ...r, viewedAt: now }
        })
        return changed ? { ...t, sessions } : t
      }),
    }))
    if (changed) {
      schedulePersist(() => get().tasks.find((t) => t.id === taskId), taskId)
    }
  },

  addRun: (taskId, session) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, sessions: [...t.sessions, session] } : t,
      ),
    }))
    schedulePersist(() => get().tasks.find((t) => t.id === taskId), taskId)
  },

  removeSession: (sessionId) => {
    const touched = new Set<string>()
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (!t.sessions.some((r) => r.id === sessionId)) return t
        touched.add(t.id)
        return { ...t, sessions: t.sessions.filter((r) => r.id !== sessionId) }
      }),
      selectedSessionId: s.selectedSessionId === sessionId ? null : s.selectedSessionId,
    }))
    for (const taskId of touched) {
      const task = get().tasks.find((t) => t.id === taskId)
      if (task) persistNow(task)
    }
  },

  updateRun: (taskId, sessionId, patch) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              sessions: t.sessions.map((r) => (r.id === sessionId ? { ...r, ...patch } : r)),
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

  addRunMessage: (taskId, sessionId, msg) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              sessions: t.sessions.map((r) =>
                r.id === sessionId ? { ...r, messages: [...r.messages, msg] } : r,
              ),
            }
          : t,
      ),
    }))
    schedulePersist(() => get().tasks.find((t) => t.id === taskId), taskId)
  },

  updateRunMessage: (taskId, sessionId, msgId, patch) => {
    // Fires on every streamed token — can be dozens per second. We keep it
    // in-memory only; the authoritative event log lives in the backend's
    // `run_events` table, and the terminal `updateRun({status:'done'})`
    // call will persist the final assembled task with the completed message.
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              sessions: t.sessions.map((r) =>
                r.id === sessionId
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

  startSessionFromTask: async (task, team) => {
    // Drafts/templates are pure samples — never embed sessions into the Task.
    // Executing a draft just copies its composed prompt into a new standalone
    // session that references the task by id (for provenance).
    const fullPrompt = composePrompt(task)
    const session = await useSessionsStore.getState().startSession({
      team,
      taskId: task.id,
      goal: fullPrompt,
    })
    return session?.id ?? null
  },

  reattachSessions: (team) => {
    // Re-attach live streams for sessions that aren't in a terminal state.
    // `needs_input` counts as non-terminal because an ask_user tool call is
    // still open server-side — answering it via the /answer endpoint resumes
    // the engine, and we need the stream hooked up to relay the follow-on
    // events.
    for (const t of get().tasks) {
      if (t.teamId !== team.id) continue
      const session = t.sessions[t.sessions.length - 1]
      if (!session) continue
      if (session.status !== 'running' && session.status !== 'needs_input') continue
      if (activeAborts.has(session.id)) continue
      void consumeRunStream(get, set, t, team, session.id, session.id)
    }
  },

  stopSession: (sessionId) => {
    // Always tell the backend to stop its session too — the in-browser
    // AbortController only closes OUR attached stream; the engine keeps
    // executing unless we explicitly cancel it server-side.
    let backendSessionId: string | undefined
    for (const t of get().tasks) {
      const r = t.sessions.find((x) => x.id === sessionId)
      if (r) {
        backendSessionId = r.id
        break
      }
    }
    const ctrl = activeAborts.get(sessionId)
    if (ctrl) ctrl.abort()
    if (backendSessionId) void stopBackendSession(backendSessionId)

    // If no live attach owned this (reload / navigated tab), there's nothing
    // local to unwind — force the row to failed so the UI is honest.
    if (!ctrl) {
      const now = new Date().toISOString()
      let ownerTaskId: string | null = null
      set((s) => ({
        tasks: s.tasks.map((t) => {
          if (!t.sessions.some((r) => r.id === sessionId)) return t
          ownerTaskId = t.id
          return {
            ...t,
            sessions: t.sessions.map((r) =>
              r.id === sessionId && r.status === 'running'
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
