/**
 * Sessions store — 1급 실행 레코드 관리.
 *
 * 태스크 스토어와 분리된 이유:
 *   - 세션은 태스크와 독립적으로 존재해야 함 (ad-hoc 실행 등).
 *   - UI (Running/Done 컬럼, /s/{id} 페이지)는 세션 평면 목록으로 표시.
 *   - SSE 이벤트 라이프사이클이 태스크 CRUD와 전혀 다른 리듬으로 움직임.
 *
 * 백엔드 ↔ 프론트 키 맵:
 *   session.id   — 영구 식별자 (URL, 스토어 key)
 *   session.taskId — 출발 템플릿 (optional)
 */

import { create } from 'zustand'
import {
  type AskUserQuestion,
  type SessionEvent,
  attachSession,
  deleteSessionRequest,
  patchSession,
  startSession,
  stopBackendSession,
} from '../api/sessions'
import { t as translate } from '../i18n'
import type { Message, PendingAsk, Session, Team } from '../types'
import { useAppStore } from './useAppStore'
import { useCanvasStore } from './useCanvasStore'
import { useDrawerStore } from './useDrawerStore'

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

// Server row shape (from /api/sessions?team_id=…).
interface ServerSessionRow {
  id: string
  team_id: string
  task_id: string | null
  goal: string
  status: string
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  title?: string | null
  pinned?: boolean
  viewed_at?: number | null
}

function mapServerStatus(row: ServerSessionRow): Session['status'] {
  if (row.status === 'running') return 'running'
  if (row.status === 'needs_input') return 'needs_input'
  if (row.status === 'error') return 'failed'
  // 'idle' (new) and legacy 'finished' / 'interrupted' all map to 'done' on
  // the client. The session is parked without a live generator but fully
  // resumable — the UI treats idle + done identically for now. Error remains
  // the only true terminal state.
  return 'done'
}

function rowToSession(row: ServerSessionRow): Session {
  return {
    id: row.id,
    taskId: row.task_id,
    teamId: row.team_id,
    goal: row.goal,
    status: mapServerStatus(row),
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.finished_at ? new Date(row.finished_at).toISOString() : undefined,
    error: row.error ?? undefined,
    messages: [],
    title: row.title ?? null,
    pinned: row.pinned ?? false,
    viewedAt: row.viewed_at ? new Date(row.viewed_at).toISOString() : undefined,
  }
}

interface SessionsState {
  sessions: Session[]
  /** Team ids for which we've already fetched the list — prevents re-hydrate
   *  on every remount. `reattach` is re-callable and idempotent on its own. */
  hydratedTeams: Set<string>

  hydrateForTeam: (teamId: string) => Promise<void>
  /** Reconnect SSE to every session whose status is still `running` for this
   *  team. Safe to call repeatedly — attaches are de-duped via `activeAborts`. */
  reattach: (team: Team) => void
  /** Kick off a new session and register the session. Pushes the new Session into
   *  the store immediately so the UI reflects "starting" state; live events
   *  overwrite it as they arrive. */
  startSession: (args: {
    team: Team
    taskId: string | null
    goal: string
  }) => Promise<Session | null>
  stopSession: (id: string) => void
  markViewed: (id: string) => void
  removeSession: (id: string) => void
  setPinned: (id: string, pinned: boolean) => void
  setTitle: (id: string, title: string | null) => void

  /** Insert or merge a session — used by the tasks store during transition
   *  so task-driven sessions still appear in the Done column as they finish. */
  upsertSession: (session: Session) => void

  // — internal —
  updateSession: (id: string, patch: Partial<Session>) => void
  addMessage: (id: string, msg: Message) => void
  updateMessage: (id: string, msgId: string, patch: Partial<Message>) => void
}

// id → AbortController for in-flight SSE attaches. Lives outside the store
// so AbortController instances aren't part of serialized state.
const activeAborts = new Map<string, AbortController>()

async function consumeStream(
  get: () => SessionsState,
  team: Team,
  session: Session,
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
    get().addMessage(session.id, {
      id: bubbleId,
      teamId: team.id,
      from: nodeId,
      text: '',
      createdAt: new Date().toISOString(),
    })
    return bubbleId
  }

  const pushSystem = (text: string) => {
    get().addMessage(session.id, {
      id: makeId('m'),
      teamId: team.id,
      from: 'system',
      text,
      createdAt: new Date().toISOString(),
    })
  }

  const abort = new AbortController()
  activeAborts.set(session.id, abort)
  let sawTerminal = false
  try {
    const iter = attachSession(session.id, { signal: abort.signal })
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
          get().updateMessage(session.id, bubbleId, {
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
            get().updateSession(session.id, { pendingAsk: pending, status: 'needs_input' })
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
          get().updateSession(session.id, { pendingAsk: undefined, status: 'running' })
          pushSystem(
            translate(
              useAppStore.getState().locale,
              Boolean((ev.data as Record<string, unknown>).skipped)
                ? 'trace.askSkipped'
                : 'trace.askAnswered',
            ),
          )
          break
        case 'turn_finished':
          // 한 턴 끝 — 세션은 살아있지만 "지금 작업 중" 은 아님. 리스트 스피너 멈춤.
          get().updateSession(session.id, {
            status: 'done',
            endedAt: new Date().toISOString(),
          })
          break
        case 'user_message':
          // 새 턴 시작 — 다시 running 으로 flip.
          get().updateSession(session.id, {
            status: 'running',
            endedAt: undefined,
          })
          break
        case 'run_error':
          pushSystem(
            translate(useAppStore.getState().locale, 'trace.runError', {
              error: String((ev.data as Record<string, unknown>).error ?? 'session failed'),
            }),
          )
          get().updateSession(session.id, {
            status: 'failed',
            endedAt: new Date().toISOString(),
            error: String((ev.data as Record<string, unknown>).error ?? 'session failed'),
          })
          sawTerminal = true
          break
        case 'run_finished':
          sawTerminal = true
          break
      }
    }
    if (sawTerminal) {
      const current = get().sessions.find((x) => x.id === session.id)
      if (current && current.status === 'running') {
        get().updateSession(session.id, {
          status: 'done',
          endedAt: new Date().toISOString(),
        })
      }
    }
  } catch (e) {
    // Stream closed (abort, HMR, network blip). Do NOT demote status — the
    // backend session keeps going server-side and the next reattach replays.
    if (abort.signal.aborted) return
    if (e instanceof Error && e.message.includes('(404)')) {
      get().removeSession(session.id)
      void import('./useTasksStore').then(({ useTasksStore }) => {
        useTasksStore.getState().removeSession(session.id)
      })
      return
    }
    return
  } finally {
    activeAborts.delete(session.id)
    setActiveAgents([])
    setActiveEdges([])
    void useDrawerStore.getState().refreshTeamArtifacts(team.id)
  }
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  hydratedTeams: new Set<string>(),

  hydrateForTeam: async (teamId) => {
    if (get().hydratedTeams.has(teamId)) return
    try {
      const res = await fetch(
        `/api/sessions?team_id=${encodeURIComponent(teamId)}&limit=200`,
      )
      if (!res.ok) return
      const rows = (await res.json()) as ServerSessionRow[]
      const fetched = rows.map(rowToSession)
      set((s) => {
        // Merge: keep in-memory sessions (live streams + their messages) and
        // overlay server rows for anything not already tracked.
        const knownUuids = new Set(s.sessions.map((x) => x.id))
        const newOnes = fetched.filter((x) => !knownUuids.has(x.id))
        const next = new Set(s.hydratedTeams)
        next.add(teamId)
        return { sessions: [...s.sessions, ...newOnes], hydratedTeams: next }
      })
    } catch (exc) {
      console.warn('[sessions] hydrate failed', exc)
    }
  },

  reattach: (team) => {
    for (const s of get().sessions) {
      if (s.teamId !== team.id) continue
      if (s.status !== 'running' && s.status !== 'needs_input') continue
      if (activeAborts.has(s.id)) continue
      void consumeStream(get, team, s)
    }
  },

  startSession: async ({ team, taskId, goal }) => {
    try {
      const { sessionId } = await startSession(team, goal, {
        locale: useAppStore.getState().locale,
        taskId: taskId ?? undefined,
      })
      const now = new Date().toISOString()
      const session: Session = {
        id: sessionId,
        taskId,
        teamId: team.id,
        goal,
        status: 'running',
        startedAt: now,
        messages: [],
      }
      set((s) => ({ sessions: [...s.sessions, session] }))
      void consumeStream(get, team, session)
      return session
    } catch (e) {
      console.error('[sessions] start failed', e)
      return null
    }
  },

  stopSession: (id) => {
    const s = get().sessions.find((x) => x.id === id)
    if (!s) return
    const ctrl = activeAborts.get(id)
    if (ctrl) ctrl.abort()
    void stopBackendSession(s.id)
    if (!ctrl) {
      // No live attach — force the row to failed so the UI is honest.
      get().updateSession(id, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        error: 'stopped by user',
      })
    }
  },

  markViewed: (id) => {
    const existing = get().sessions.find((x) => x.id === id)
    if (existing?.viewedAt) return
    const now = new Date().toISOString()
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id && !x.viewedAt ? { ...x, viewedAt: now } : x,
      ),
    }))
    // Persist server-side so the flag survives reload / server restart. Other
    // meta mutations (pin/title) already do this; viewed was missed until now.
    void patchSession(id, { viewed: true })
  },

  removeSession: (id) => {
    // Optimistic local remove + fire-and-forget server DELETE so the folder
    // under ~/.openhive/sessions/{id} is actually gone on disk.
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }))
    void deleteSessionRequest(id)
  },

  setPinned: (id, pinned) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, pinned } : x)),
    }))
    void patchSession(id, { pinned })
  },

  setTitle: (id, title) => {
    const normalized = title && title.trim().length > 0 ? title.trim() : null
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: normalized } : x)),
    }))
    void patchSession(id, { title: normalized })
  },

  upsertSession: (session) => {
    set((s) => {
      const existing = s.sessions.findIndex((x) => x.id === session.id)
      if (existing < 0) return { sessions: [...s.sessions, session] }
      const merged = [...s.sessions]
      merged[existing] = { ...merged[existing], ...session }
      return { sessions: merged }
    })
  },

  updateSession: (id, patch) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }))
  },

  addMessage: (id, msg) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, messages: [...x.messages, msg] } : x,
      ),
    }))
  },

  updateMessage: (id, msgId, patch) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              messages: x.messages.map((m) =>
                m.id === msgId ? { ...m, ...patch } : m,
              ),
            }
          : x,
      ),
    }))
  },
}))
