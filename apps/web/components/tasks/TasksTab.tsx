import {
  CaretDown,
  CaretRight,
  ChatCircle,
  ChatsCircle,
  CircleNotch,
  Clock,
  DotsThreeVertical,
  FileText,
  PencilSimple,
  PushPin,
  PushPinSlash,
  Play,
  Plus,
  Sparkle,
  Trash,
  Warning,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { type CreateTaskInput, NewTaskModal } from '@/components/modals/NewTaskModal'
import { TaskDetailModal } from '@/components/tasks/TaskDetailModal'
import { PageEmptyState } from '@/components/ui/PageEmptyState'
import { useT } from '@/lib/i18n'
import { loadViewedIds, saveViewedIds } from '@/lib/sessionViewed'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useSessionsStore } from '@/lib/stores/useSessionsStore'
import { useTasksStore } from '@/lib/stores/useTasksStore'
import type { Session, Task } from '@/lib/types'
import { Button } from '../ui/Button'
import {
  SUPPORTED_PROVIDERS,
  fmtRelative,
  makeTaskId,
} from './shared'

/** "Task = 템플릿, Session = 영속 채팅" 모델의 인박스 레이아웃.
 *  왼쪽 = 템플릿 rail, 오른쪽 = 세션 평면 리스트.
 *  시각 상태 5종:
 *   - working  = running (스피너)
 *   - waiting  = needs_input / pendingAsk (답변 필요, 강조)
 *   - done-fresh = done & 아직 viewedAt 없음 (살짝 튀게 — 새 결과 배지)
 *   - done-seen  = done & viewedAt 있음 (평범)
 *   - failed   = 실패 (원인은 session.error 에. interrupted/cancelled 포함) */

type SessionState =
  | 'working'
  | 'waiting'
  | 'done-fresh'
  | 'done-seen'
  | 'failed-fresh'
  | 'failed-seen'

/** 인박스 버킷 우선순위 — 숫자 작을수록 위.
 *  1) 유저 액션 블록: waiting → failed-fresh
 *  2) FYI 신규: done-fresh
 *  3) 진행 중: working
 *  4) 아카이브(확인됨): done-seen / failed-seen — 시간순 */
const STATE_BUCKET: Record<SessionState, number> = {
  waiting: 0,
  'failed-fresh': 1,
  'done-fresh': 2,
  working: 3,
  'done-seen': 4,
  'failed-seen': 4,
}

type SessionTabKey = 'all' | 'waiting' | 'working' | 'done' | 'failed'

/** 탭별로 어떤 SessionState 들이 포함되는지. 'all' 은 전부. */
function stateInTab(state: SessionState, tab: SessionTabKey): boolean {
  if (tab === 'all') return true
  if (tab === 'waiting') return state === 'waiting'
  if (tab === 'working') return state === 'working'
  if (tab === 'done') return state === 'done-fresh' || state === 'done-seen'
  return state === 'failed-fresh' || state === 'failed-seen'
}

/** 라이브(task.sessions 기반)든 아카이브(sessions store 기반)든 동일 모양으로 뽑아
 *  리스트 렌더링을 단일화한다. Phase 2b에서 source=task.sessions 경로는 제거 예정. */
interface UnifiedSession {
  /** 세션 UUID — 아카이브 세션은 실제 UUID, 라이브 런은 id를 아직 못 받았을
   *  때만 `live:<clientSessionId>` 형태의 임시 키로 내려온다. */
  id: string | null
  taskId: string | null
  title: string
  preview: string
  state: SessionState
  /** ISO — 정렬용. */
  timestampIso: string
  /** 사람이 읽는 상대 시간. */
  relTime: string
  /** 클릭 시 페이지 이동할 수 있는 UUID 가 있는지. */
  navigable: boolean
  /** 사용자가 고정한 세션. 정렬 시 맨 위. (아직 목업 단계) */
  pinned?: boolean
}

function stateFromRun(r: Session, isViewed: boolean): SessionState {
  if (r.pendingAsk || r.status === 'needs_input') return 'waiting'
  if (r.status === 'running') return 'working'
  const seen = !!r.viewedAt || isViewed
  if (r.status === 'failed') return seen ? 'failed-seen' : 'failed-fresh'
  return seen ? 'done-seen' : 'done-fresh'
}

function stateFromSession(s: Session, isViewed: boolean): SessionState {
  if (s.pendingAsk || s.status === 'needs_input') return 'waiting'
  if (s.status === 'running') return 'working'
  const seen = !!s.viewedAt || isViewed
  if (s.status === 'failed') return seen ? 'failed-seen' : 'failed-fresh'
  return seen ? 'done-seen' : 'done-fresh'
}

/** "0 9 * * *" → "09:00 (매일)" 등 대략적 설명. cron-parser 없이 */
function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [min, hour, dom, _mon, dow] = parts as [string, string, string, string, string]
  const timeStr =
    /^\d+$/.test(min) && /^\d+$/.test(hour)
      ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
      : null
  if (dom === '*' && dow === '*' && timeStr) return `${timeStr} · 매일`
  if (dom === '*' && dow !== '*' && timeStr) {
    const names: Record<string, string> = {
      MON: '월', TUE: '화', WED: '수', THU: '목', FRI: '금', SAT: '토', SUN: '일',
      '1': '월', '2': '화', '3': '수', '4': '목', '5': '금', '6': '토', '0': '일',
    }
    const label = names[dow.toUpperCase()] ?? dow
    return `${timeStr} · ${label}요일`
  }
  if (dom !== '*' && dow === '*' && timeStr) return `${timeStr} · 매월 ${dom}일`
  if (min === '0' && hour === '*') return '매시 정각'
  return cron
}


/** 섹션 접힘 상태 persist. 팀 전환해도 재현되게 LS 에 저장한다.
 *  기본값 규칙: 유저가 아직 토글한 적 없는 섹션은 "비어 있으면 접힘, 항목이
 *  하나라도 있으면 펼침". 한 번이라도 토글하면 그 의사를 유지한다. */
function useCollapsedSections(counts: { drafts: number; scheduled: number }): {
  collapsed: { drafts: boolean; scheduled: boolean }
  toggle: (key: 'drafts' | 'scheduled') => void
} {
  const LS_KEY = 'openhive.tasks.rail.collapsed'
  const [stored, setStored] = useState<{
    drafts: boolean | undefined
    scheduled: boolean | undefined
  }>({ drafts: undefined, scheduled: undefined })

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<{
        drafts: boolean
        scheduled: boolean
      }>
      setStored({ drafts: parsed.drafts, scheduled: parsed.scheduled })
    } catch {
      /* ignore corrupt LS */
    }
  }, [])

  const collapsed = {
    drafts: stored.drafts ?? counts.drafts === 0,
    scheduled: stored.scheduled ?? counts.scheduled === 0,
  }

  const toggle = (key: 'drafts' | 'scheduled') => {
    setStored((s) => {
      const current = s[key] ?? counts[key] === 0
      const next = { ...s, [key]: !current }
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next))
      } catch {
        /* private-mode / quota — ignore */
      }
      return next
    })
  }

  return { collapsed, toggle }
}

export function TasksTab() {
  const t = useT()
  const team = useCurrentTeam()
  const navigate = useNavigate()
  const params = useParams<{ companySlug: string; teamSlug: string }>()
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const locale = useAppStore((s) => s.locale)

  // tasks store
  const tasks = useTasksStore((s) => s.tasks)
  const addTask = useTasksStore((s) => s.addTask)
  const selectTaskAsDraft = useTasksStore((s) => s.selectTaskAsDraft)
  const selectedTaskId = useTasksStore((s) => s.selectedTaskId)
  const selectTask = useTasksStore((s) => s.selectTask)
  const startSessionFromTask = useTasksStore((s) => s.startSessionFromTask)
  const reattachTaskSessions = useTasksStore((s) => s.reattachSessions)

  // sessions store (Done + 아카이브)
  const allSessions = useSessionsStore((s) => s.sessions)
  const hydrateSessionsForTeam = useSessionsStore((s) => s.hydrateForTeam)
  const reattachSessionsStore = useSessionsStore((s) => s.reattach)
  const markSessionViewed = useSessionsStore((s) => s.markViewed)
  const markRunViewed = useTasksStore((s) => s.markRunViewed)
  const removeSession = useSessionsStore((s) => s.removeSession)
  const setSessionPinned = useSessionsStore((s) => s.setPinned)
  const setSessionTitle = useSessionsStore((s) => s.setTitle)

  const [showNew, setShowNew] = useState(false)
  // Viewed flag is still localStorage-only. Pin / title are server-backed via
  // useSessionsStore actions.
  const [viewedIds, setViewedIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    setViewedIds(loadViewedIds())
  }, [])
  const markViewedLocal = (id: string) => {
    setViewedIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      saveViewedIds(next)
      return next
    })
  }
  const togglePinned = (id: string) => {
    const current = allSessions.find((s) => s.id === id)
    setSessionPinned(id, !(current?.pinned ?? false))
  }
  const renameSession = (id: string, title: string) => {
    setSessionTitle(id, title)
  }
  const [sessionTab, setSessionTab] = useState<SessionTabKey>('all')

  useEffect(() => {
    if (!team) return
    void hydrateSessionsForTeam(team.id)
    reattachTaskSessions(team)
    reattachSessionsStore(team)
  }, [team, reattachTaskSessions, reattachSessionsStore, hydrateSessionsForTeam])

  const teamTasks = useMemo(
    () => tasks.filter((task) => task.teamId === currentTeamId),
    [tasks, currentTeamId],
  )

  const teamSessions = useMemo(
    () => allSessions.filter((s) => s.teamId === currentTeamId),
    [allSessions, currentTeamId],
  )

  /** 라이브 task.sessions → UnifiedSession 변환. 같은 sessionId 가 아카이브
   *  세션에도 있으면 그쪽이 override 되도록 매핑 key 는 sessionId 기반. */
  const unifiedSessions = useMemo(() => {
    const map = new Map<string, UnifiedSession>()

    // 1) Tasks 스토어의 살아있는 sessions. Collapse 이후 session.id 가
    //    영속 백엔드 id 라서 항상 네비게이션 가능.
    for (const task of teamTasks) {
      for (const session of task.sessions) {
        const key = session.id || `client:${session.clientSessionId ?? ''}`
        const lastMsg = session.messages[session.messages.length - 1]
        const preview =
          session.error ??
          lastMsg?.text ??
          task.prompt.split('\n')[0] ??
          ''
        map.set(key, {
          id: session.id || null,
          taskId: task.id,
          title: task.title,
          preview: preview.slice(0, 140),
          state: stateFromRun(session, viewedIds.has(session.id ?? '')),
          timestampIso: session.endedAt ?? session.startedAt,
          relTime: fmtRelative(session.endedAt ?? session.startedAt, t, locale),
          navigable: !!session.id,
        })
      }
    }

    // 2) Sessions 스토어. 같은 sessionId 가 이미 있으면 UUID/정확 상태로 덮어씀.
    for (const s of teamSessions) {
      const key = s.id
      const existing = map.get(key)
      const ownerTask = tasks.find((x) => x.id === s.taskId) ?? null
      const lastMsg = s.messages[s.messages.length - 1]
      const preview =
        s.error ??
        lastMsg?.text ??
        (ownerTask?.prompt.split('\n')[0] ?? s.goal.split('\n')[0] ?? '')
      // Display title precedence: user-renamed > auto-title > owning task title
      // > goal slice. All server-backed except the owning-task fallback.
      const displayTitle =
        (s.title && s.title.trim().length > 0 ? s.title : null) ??
        ownerTask?.title ??
        s.goal.split('\n')[0] ??
        t('tasks.sessionDefault')
      map.set(key, {
        id: s.id,
        taskId: s.taskId,
        title: displayTitle,
        preview: (existing?.preview && stateFromSession(s, viewedIds.has(s.id)) !== 'done-seen'
          ? existing.preview
          : preview
        ).slice(0, 140),
        state: stateFromSession(s, viewedIds.has(s.id)),
        timestampIso: s.endedAt ?? s.startedAt,
        relTime: fmtRelative(s.endedAt ?? s.startedAt, t, locale),
        navigable: true,
        pinned: s.pinned ?? false,
      })
    }

    const rows = Array.from(map.values())
    return rows.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      const bucketDiff = STATE_BUCKET[a.state] - STATE_BUCKET[b.state]
      if (bucketDiff !== 0) return bucketDiff
      return Date.parse(b.timestampIso) - Date.parse(a.timestampIso)
    })
  }, [teamTasks, teamSessions, tasks, t, locale, viewedIds])

  const sessionTabCounts = useMemo(() => {
    const counts: Record<SessionTabKey, number> = {
      all: unifiedSessions.length,
      waiting: 0,
      working: 0,
      done: 0,
      failed: 0,
    }
    for (const s of unifiedSessions) {
      if (s.state === 'waiting') counts.waiting++
      else if (s.state === 'working') counts.working++
      else if (s.state === 'done-fresh' || s.state === 'done-seen') counts.done++
      else counts.failed++
    }
    return counts
  }, [unifiedSessions])

  const visibleSessions = useMemo(
    () => unifiedSessions.filter((s) => stateInTab(s.state, sessionTab)),
    [unifiedSessions, sessionTab],
  )

  const { scheduledTemplates, draftTemplates } = useMemo(() => {
    // Primary sort: user-defined orderIndex (lower first). Fallback: newest
    // createdAt first. Tasks without an orderIndex land after ordered ones.
    const sorted = [...teamTasks].sort((a, b) => {
      const ai = a.orderIndex ?? Number.POSITIVE_INFINITY
      const bi = b.orderIndex ?? Number.POSITIVE_INFINITY
      if (ai !== bi) return ai - bi
      return Date.parse(b.createdAt) - Date.parse(a.createdAt)
    })
    return {
      scheduledTemplates: sorted.filter(
        (x) => x.mode === 'scheduled' && !!x.cron,
      ),
      draftTemplates: sorted.filter(
        (x) => !(x.mode === 'scheduled' && !!x.cron),
      ),
    }
  }, [teamTasks])

  const { collapsed, toggle: toggleSection } = useCollapsedSections({
    drafts: draftTemplates.length,
    scheduled: scheduledTemplates.length,
  })

  const selectedTask = teamTasks.find((x) => x.id === selectedTaskId) ?? null

  const unsupported = useMemo(() => {
    if (!team) return []
    return team.agents
      .filter((a) => !SUPPORTED_PROVIDERS.has(a.providerId))
      .map((a) => a.role)
  }, [team])

  const handleCreate = (input: CreateTaskInput) => {
    const underlyingMode: 'now' | 'scheduled' =
      input.mode === 'scheduled' ? 'scheduled' : 'now'
    const task: Task = {
      id: makeTaskId(),
      teamId: currentTeamId,
      title: input.title,
      prompt: input.prompt,
      mode: underlyingMode,
      cron: input.cron,
      createdAt: new Date().toISOString(),
      sessions: [],
      references: input.references,
    }
    addTask(task)
    setShowNew(false)
  }

  const updateTask = useTasksStore((s) => s.updateTask)
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: 'before' | 'after'
  } | null>(null)

  /** Commit a new order for a group (drafts or scheduled). Writes orderIndex
   *  on every member so the list round-trips through yaml/server. */
  const reorderGroup = (groupIds: string[]) => {
    groupIds.forEach((id, i) => {
      const current = tasks.find((t) => t.id === id)
      if (!current || current.orderIndex === i) return
      updateTask(id, { orderIndex: i })
    })
  }

  const handleDrop = (
    groupIds: string[],
    targetId: string,
    position: 'before' | 'after',
  ) => {
    setDropTarget(null)
    const src = draggingTaskId
    setDraggingTaskId(null)
    if (!src || src === targetId) return
    if (!groupIds.includes(src) || !groupIds.includes(targetId)) return
    const without = groupIds.filter((x) => x !== src)
    const idx = without.indexOf(targetId)
    if (idx === -1) return
    without.splice(position === 'before' ? idx : idx + 1, 0, src)
    reorderGroup(without)
  }

  const [launchingTaskId, setLaunchingTaskId] = useState<string | null>(null)
  const play = async (task: Task) => {
    if (!team || launchingTaskId) return
    setLaunchingTaskId(task.id)
    try {
      await startSessionFromTask(task, team)
    } finally {
      setLaunchingTaskId(null)
    }
  }

  /** 새 채팅 화면으로 이동. 거기서 첫 메시지 입력 → 세션 생성 → `/s/{id}` 로. */
  const goNewChat = () => {
    if (!params?.companySlug || !params?.teamSlug) return
    navigate(`/${params.companySlug}/${params.teamSlug}/new`)
  }

  const openSession = (u: UnifiedSession) => {
    // viewedAt 을 두 스토어 모두에 세팅 — 같은 세션이 task.sessions 에도,
    // 독립 sessions store 에도 존재할 수 있어서 양쪽 다 찍는다. (각 액션은
    // 이미 본 세션이면 no-op.)
    if (u.id) {
      markSessionViewed(u.id)
      if (u.taskId) markRunViewed(u.taskId, u.id)
      markViewedLocal(u.id)
    }
    if (u.id && u.navigable && params?.companySlug && params?.teamSlug) {
      navigate(`/${params.companySlug}/${params.teamSlug}/s/${u.id}`)
      return
    }
    // 라이브 런이라 UUID 를 아직 모르는 경우 — 짧게 기다려도 대부분 바로 나와서
    // 다음 탭 오픈 때 네비 가능. 지금은 템플릿 상세(드래프트)를 열어둔다.
    if (u.taskId) selectTaskAsDraft(u.taskId)
  }

  return (
    <div className="h-full w-full flex flex-col bg-neutral-50 dark:bg-neutral-950">
      {unsupported.length > 0 && (
        <div className="shrink-0 px-6 pt-3">
          <div className="flex items-start gap-2 border border-neutral-300 text-neutral-700 text-[13px] px-3 py-2 rounded-sm bg-white">
            <Warning className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="leading-relaxed">
              {t('chat.unsupportedProviders', {
                roles: unsupported.join(', '),
              })}
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* Templates rail */}
        <aside className="w-[280px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col">
          {/* 상단 CTA — 업무(템플릿) 만들기 / 즉석 채팅 시작. 사이드바 모든 상태에서
              최상단에 고정. */}
          <div className="shrink-0 px-3 py-3 grid grid-cols-2 gap-2 border-b border-neutral-100 dark:border-neutral-800">
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="inline-flex items-center justify-center gap-1 h-[34px] px-[20px] text-[13px] leading-none bg-neutral-900 text-white rounded-sm hover:bg-neutral-800"
            >
              <Plus weight="bold" className="w-3.5 h-3.5" />
              {t('tasks.newTask')}
            </button>
            <button
              type="button"
              onClick={goNewChat}
              disabled={!team}
              className="inline-flex items-center justify-center gap-1 h-[34px] px-[20px] text-[13px] leading-none border border-neutral-300 dark:border-neutral-700 text-neutral-800 dark:text-neutral-100 rounded-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChatCircle weight="regular" className="w-3.5 h-3.5" />
              {t('tasks.newChat')}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* 스케줄 — cron 걸린 템플릿. Drafts 위에 배치. */}
            <CollapsibleSection
              icon={<Clock className="w-3.5 h-3.5" />}
              label={t('tasks.scheduled')}
              count={scheduledTemplates.length}
              collapsed={collapsed.scheduled}
              onToggle={() => toggleSection('scheduled')}
            >
              {scheduledTemplates.length === 0 ? null : (
                scheduledTemplates.map((task) => {
                  const groupIds = scheduledTemplates.map((x) => x.id)
                  return (
                    <TemplateRow
                      key={task.id}
                      task={task}
                      onRun={() => play(task)}
                      onEdit={() => selectTaskAsDraft(task.id)}
                      isDragging={draggingTaskId === task.id}
                      dropIndicator={
                        dropTarget?.id === task.id ? dropTarget.position : null
                      }
                      onDragStart={() => setDraggingTaskId(task.id)}
                      onDragEnd={() => {
                        setDraggingTaskId(null)
                        setDropTarget(null)
                      }}
                      onDragOver={(pos) => {
                        if (!draggingTaskId || draggingTaskId === task.id) return
                        setDropTarget((prev) =>
                          prev?.id === task.id && prev.position === pos
                            ? prev
                            : { id: task.id, position: pos },
                        )
                      }}
                      onDragLeave={() =>
                        setDropTarget((prev) => (prev?.id === task.id ? null : prev))
                      }
                      onDrop={() => {
                        if (!dropTarget) return
                        handleDrop(groupIds, dropTarget.id, dropTarget.position)
                      }}
                    />
                  )
                })
              )}
            </CollapsibleSection>
            {/* 드래프트 — 일회성 템플릿 */}
            <CollapsibleSection
              icon={<FileText className="w-3.5 h-3.5" />}
              label={t('tasks.drafts')}
              count={draftTemplates.length}
              collapsed={collapsed.drafts}
              onToggle={() => toggleSection('drafts')}
            >
              {draftTemplates.length === 0 ? null : (
                draftTemplates.map((task) => {
                  const groupIds = draftTemplates.map((x) => x.id)
                  return (
                    <TemplateRow
                      key={task.id}
                      task={task}
                      onRun={() => play(task)}
                      onEdit={() => selectTaskAsDraft(task.id)}
                      isDragging={draggingTaskId === task.id}
                      dropIndicator={
                        dropTarget?.id === task.id ? dropTarget.position : null
                      }
                      onDragStart={() => setDraggingTaskId(task.id)}
                      onDragEnd={() => {
                        setDraggingTaskId(null)
                        setDropTarget(null)
                      }}
                      onDragOver={(pos) => {
                        if (!draggingTaskId || draggingTaskId === task.id) return
                        setDropTarget((prev) =>
                          prev?.id === task.id && prev.position === pos
                            ? prev
                            : { id: task.id, position: pos },
                        )
                      }}
                      onDragLeave={() =>
                        setDropTarget((prev) => (prev?.id === task.id ? null : prev))
                      }
                      onDrop={() => {
                        if (!dropTarget) return
                        handleDrop(groupIds, dropTarget.id, dropTarget.position)
                      }}
                    />
                  )
                })
              )}
            </CollapsibleSection>
          </div>
        </aside>

        {/* Session inbox */}
        <main className="flex-1 flex flex-col min-w-0">
          <SessionTabBar
            active={sessionTab}
            onChange={setSessionTab}
            counts={sessionTabCounts}
          />
          {visibleSessions.length === 0 ? (
            <EmptyInbox t={t} truly={unifiedSessions.length === 0} />
          ) : (
            <div className="flex-1 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800">
              {visibleSessions.map((u) => {
                const sid = u.id ?? ''
                const canDelete = !!sid
                return (
                  <SessionInboxRow
                    key={sid || `${u.taskId}:${u.timestampIso}`}
                    session={u}
                    onOpen={() => openSession(u)}
                    onPinToggle={sid ? () => togglePinned(sid) : undefined}
                    onRename={
                      sid
                        ? () => {
                            const input = window.prompt(t('tasks.renamePrompt'), u.title)
                            const trimmed = input?.trim()
                            if (trimmed) renameSession(sid, trimmed)
                          }
                        : undefined
                    }
                    onDelete={canDelete ? () => removeSession(sid) : undefined}
                  />
                )
              })}
            </div>
          )}
        </main>
      </div>

      <NewTaskModal open={showNew} onClose={() => setShowNew(false)} onSubmit={handleCreate} />
      <TaskDetailModal task={selectedTask} onClose={() => selectTask(null)} />
    </div>
  )
}

/** Empty state for the session inbox. Two modes:
 *   - truly=true  → nothing exists anywhere. Show headline + subtitle + the
 *     two primary CTAs (새 업무 / 새 채팅) so the user always has a next step,
 *     plus a tertiary "run this draft" if the rail already has one.
 *   - truly=false → other tabs have rows but this filter is empty. Softer
 *     copy, no CTAs — the user just needs to switch tabs. */
function EmptyInbox({
  t,
  truly,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string
  truly: boolean
}) {
  return (
    <PageEmptyState icon={<ChatsCircle weight="thin" className="w-10 h-10" />}>
      {truly ? t('tasks.sessionsEmpty') : t('tasks.noInTab')}
    </PageEmptyState>
  )
}

/** 좌측 rail 의 접이식 섹션. 헤더 전체가 toggle 버튼. accent 는 스케줄 같이
 *  살짝 다른 정체성을 주고 싶은 섹션에 amber 톤 띠를 달아준다. */
function CollapsibleSection({
  icon,
  label,
  count,
  collapsed,
  onToggle,
  accent,
  children,
}: {
  icon?: React.ReactNode
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  accent?: 'amber'
  children: React.ReactNode
}) {
  return (
    <section
      className="relative border-t border-neutral-100 dark:border-neutral-800 first:border-t-0"
    >
      <button
        type="button"
        onClick={onToggle}
        className={clsx(
          'w-full px-3 py-2 flex items-center gap-1.5 text-left transition-colors',
          'bg-gradient-to-b from-neutral-50 to-white dark:from-neutral-900 dark:to-neutral-950',
          'hover:from-neutral-100 hover:to-neutral-50 dark:hover:from-neutral-800',
          'sticky top-0 z-10 border-b border-neutral-100 dark:border-neutral-800',
        )}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <CaretRight className="w-3 h-3 text-neutral-400" />
        ) : (
          <CaretDown className="w-3 h-3 text-neutral-500" />
        )}
        <span
          className={clsx(
            'shrink-0',
            accent === 'amber' ? 'text-amber-600' : 'text-neutral-500',
          )}
        >
          {icon}
        </span>
        <span className="text-[11.5px] font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
          {label}
        </span>
        <span className="ml-auto text-[11px] font-mono text-neutral-400 tabular-nums">
          {count}
        </span>
      </button>
      {!collapsed && (
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {children}
        </div>
      )}
    </section>
  )
}

/** 행 맨 앞 상태 아이콘 — "모두 원형" 한 패밀리.
 *  실루엣이 전부 동그라미, 내부 글리프와 fill/outline 으로만 상태 차별화.
 *  컬러는 실패에만. 나머지는 뉴트럴. */
function StateIndicator({ state }: { state: SessionState }) {
  const t = useT()
  if (state === 'working') {
    return (
      <CircleNotch
        weight="bold"
        className="w-4 h-4 text-neutral-500 dark:text-neutral-400 animate-spin"
        aria-label={t('tasks.state.working')}
      />
    )
  }
  if (state === 'waiting') {
    return (
      <span className="w-4 h-4 flex items-center justify-center" aria-label={t('tasks.state.waiting')}>
        <span className="w-2 h-2 rounded-full bg-amber-500" />
      </span>
    )
  }
  if (state === 'done-fresh') {
    return (
      <span className="w-4 h-4 flex items-center justify-center" aria-label={t('tasks.state.doneFresh')}>
        <span className="w-2 h-2 rounded-full bg-neutral-900 dark:bg-neutral-100" />
      </span>
    )
  }
  if (state === 'done-seen') {
    return (
      <span className="w-4 h-4 flex items-center justify-center" aria-label={t('tasks.state.done')}>
        <span className="w-2 h-2 rounded-full border border-neutral-300 dark:border-neutral-600" />
      </span>
    )
  }
  if (state === 'failed-fresh') {
    return (
      <Warning
        weight="fill"
        className="w-4 h-4 text-red-600 dark:text-red-500"
        aria-label={t('tasks.state.failed')}
      />
    )
  }
  return (
    <Warning
      className="w-4 h-4 text-red-300 dark:text-red-800"
      aria-label={t('tasks.state.failedSeen')}
    />
  )
}

function TemplateRow({
  task,
  onRun,
  onEdit,
  isDragging,
  dropIndicator,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  task: Task
  onRun: () => void
  onEdit: () => void
  isDragging?: boolean
  dropIndicator?: 'before' | 'after' | null
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragOver?: (pos: 'before' | 'after') => void
  onDragLeave?: () => void
  onDrop?: () => void
}) {
  const t = useT()
  const isScheduled = task.mode === 'scheduled' && !!task.cron
  const hint = isScheduled
    ? describeCron(task.cron ?? '')
    : task.prompt.split('\n')[0]?.slice(0, 80) ?? ''

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', task.id)
        onDragStart?.()
      }}
      onDragEnd={() => onDragEnd?.()}
      onDragOver={(e) => {
        if (!onDragOver) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
        onDragOver(pos)
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null
        if (!next || !e.currentTarget.contains(next)) onDragLeave?.()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop?.()
      }}
      onClick={onEdit}
      onKeyDown={(e) => e.key === 'Enter' && onEdit()}
      className={clsx(
        'group relative px-4 py-2.5 cursor-pointer transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/40',
        isDragging && 'opacity-40',
      )}
    >
      {dropIndicator === 'before' && (
        <div className="absolute -top-px left-0 right-0 h-0.5 bg-neutral-400 dark:bg-neutral-500 pointer-events-none" />
      )}
      {dropIndicator === 'after' && (
        <div className="absolute -bottom-px left-0 right-0 h-0.5 bg-neutral-400 dark:bg-neutral-500 pointer-events-none" />
      )}
      <div className="flex items-center gap-2">
        {isScheduled ? (
          <Clock className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
        ) : (
          <FileText className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
        )}
        <span className="text-[14px] font-medium text-neutral-900 dark:text-neutral-100 truncate flex-1">
          {task.title}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRun()
          }}
          aria-label={t('tasks.session')}
          title={t('tasks.session')}
          className={clsx(
            'shrink-0 w-6 h-6 rounded-sm flex items-center justify-center transition-colors',
            'opacity-0 group-hover:opacity-100',
            'text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800',
          )}
        >
          <Play weight="fill" className="w-3 h-3" />
        </button>
      </div>
      <div className="mt-0.5 ml-[22px] text-[12px] text-neutral-500 truncate font-mono">
        {hint}
      </div>
    </div>
  )
}

/** 세션 목록 상단 탭 바 — 상태별 필터. 밑줄 형태로 심플. */
function SessionTabBar({
  active,
  onChange,
  counts,
}: {
  active: SessionTabKey
  onChange: (k: SessionTabKey) => void
  counts: Record<SessionTabKey, number>
}) {
  const t = useT()
  const tabs: Array<{ key: SessionTabKey; label: string }> = [
    { key: 'all', label: t('tasks.tab.all') },
    { key: 'waiting', label: t('tasks.tab.waiting') },
    { key: 'working', label: t('tasks.tab.working') },
    { key: 'done', label: t('tasks.tab.done') },
    { key: 'failed', label: t('tasks.tab.failed') },
  ]
  return (
    <div className="shrink-0 px-3 pt-1 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950">
      <div className="flex items-center gap-0.5">
        {tabs.map((tab) => {
          const isActive = active === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={clsx(
                'relative px-2.5 py-1.5 text-[13px] transition-colors -mb-px border-b-2',
                isActive
                  ? 'border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100 font-medium'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 행 끝의 더보기 버튼(`⋮`). 드롭다운에 고정 / 제목 변경 / 삭제 3개. */
function RowMoreMenu({
  pinned,
  onPinToggle,
  onRename,
  onDelete,
}: {
  pinned?: boolean
  onPinToggle?: () => void
  onRename?: () => void
  onDelete?: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const hasAny = !!onPinToggle || !!onRename || !!onDelete

  const itemClass =
    'w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (hasAny) setOpen((v) => !v)
        }}
        disabled={!hasAny}
        aria-label={t('tasks.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          'w-6 h-6 rounded-sm flex items-center justify-center transition-opacity',
          // 호버 시(또는 메뉴 열림 시) 만 노출. 부모 row 의 group 훅을 사용.
          open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
          !hasAny
            ? 'text-neutral-200 dark:text-neutral-800 cursor-default'
            : 'text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 dark:text-neutral-500 dark:hover:text-neutral-100 dark:hover:bg-neutral-800',
        )}
      >
        <DotsThreeVertical weight="bold" className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-7 z-20 min-w-[150px] bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-sm shadow-md py-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!onPinToggle}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onPinToggle?.()
            }}
            className={clsx(
              itemClass,
              'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800',
            )}
          >
            {pinned ? (
              <PushPinSlash className="w-3.5 h-3.5" />
            ) : (
              <PushPin className="w-3.5 h-3.5" />
            )}
            {pinned ? t('tasks.unpin') : t('tasks.pin')}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!onRename}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onRename?.()
            }}
            className={clsx(
              itemClass,
              'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800',
            )}
          >
            <PencilSimple className="w-3.5 h-3.5" />
            {t('tasks.rename')}
          </button>
          <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
          <button
            type="button"
            role="menuitem"
            disabled={!onDelete}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onDelete?.()
            }}
            className={clsx(
              itemClass,
              'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40',
            )}
          >
            <Trash className="w-3.5 h-3.5" />
            {t('tasks.delete')}
          </button>
        </div>
      )}
    </div>
  )
}

function SessionInboxRow({
  session,
  onOpen,
  onPinToggle,
  onRename,
  onDelete,
}: {
  session: UnifiedSession
  onOpen: () => void
  onPinToggle?: () => void
  onRename?: () => void
  onDelete?: () => void
}) {
  const t = useT()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="group px-4 py-2 cursor-pointer flex items-center gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
    >
      <div className="shrink-0 w-4 h-4 flex items-center justify-center">
        <StateIndicator state={session.state} />
      </div>
      <span
        title={session.title}
        className={clsx(
          'flex-1 min-w-0 truncate text-[14px]',
          session.state === 'done-seen' || session.state === 'failed-seen'
            ? 'font-normal text-neutral-500 dark:text-neutral-400'
            : 'font-medium text-neutral-900 dark:text-neutral-100',
        )}
      >
        {session.title}
      </span>
      <span
        className="shrink-0 text-[11px] font-mono text-neutral-400 tabular-nums"
        suppressHydrationWarning
      >
        {session.relTime}
      </span>
      <RowMoreMenu
        pinned={session.pinned}
        onPinToggle={onPinToggle}
        onRename={onRename}
        onDelete={onDelete}
      />
    </div>
  )
}
