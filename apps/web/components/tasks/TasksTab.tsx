'use client'

import {
  CaretDown,
  CaretRight,
  Clock,
  FileText,
  Play,
  Plus,
  Sparkle,
  Trash,
  Warning,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { type CreateTaskInput, NewTaskModal } from '@/components/modals/NewTaskModal'
import { TaskDetailModal } from '@/components/tasks/TaskDetailModal'
import { useT } from '@/lib/i18n'
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
 *  상태는 working / waiting / idle 3개만. failed / interrupted 는 idle로 접히고
 *  마지막 메시지가 실패 이유를 담는다. needs_input = waiting. */

type SessionState = 'working' | 'waiting' | 'idle'

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
}

function stateFromRun(r: Session): SessionState {
  if (r.pendingAsk || r.status === 'needs_input') return 'waiting'
  if (r.status === 'running') return 'working'
  return 'idle'
}

function stateFromSession(s: Session): SessionState {
  if (s.pendingAsk || s.status === 'needs_input') return 'waiting'
  if (s.status === 'running') return 'working'
  return 'idle'
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
 *  SSR-safe: 첫 렌더는 기본값으로 오고, 브라우저 mount 후 값이 동기화된다. */
function useCollapsedSections(): {
  collapsed: { drafts: boolean; scheduled: boolean }
  toggle: (key: 'drafts' | 'scheduled') => void
} {
  const LS_KEY = 'openhive.tasks.rail.collapsed'
  const [collapsed, setCollapsed] = useState<{
    drafts: boolean
    scheduled: boolean
  }>({ drafts: false, scheduled: false })

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<{
        drafts: boolean
        scheduled: boolean
      }>
      setCollapsed((s) => ({
        drafts: parsed.drafts ?? s.drafts,
        scheduled: parsed.scheduled ?? s.scheduled,
      }))
    } catch {
      /* ignore corrupt LS */
    }
  }, [])

  const toggle = (key: 'drafts' | 'scheduled') => {
    setCollapsed((s) => {
      const next = { ...s, [key]: !s[key] }
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
  const router = useRouter()
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
  const removeSession = useSessionsStore((s) => s.removeSession)

  const [showNew, setShowNew] = useState(false)
  const { collapsed, toggle: toggleSection } = useCollapsedSections()

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
          state: stateFromRun(session),
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
      map.set(key, {
        id: s.id,
        taskId: s.taskId,
        title: ownerTask?.title ?? s.goal.split('\n')[0]?.slice(0, 80) ?? '세션',
        preview: (existing?.preview && stateFromSession(s) !== 'idle'
          ? existing.preview
          : preview
        ).slice(0, 140),
        state: stateFromSession(s),
        timestampIso: s.endedAt ?? s.startedAt,
        relTime: fmtRelative(s.endedAt ?? s.startedAt, t, locale),
        navigable: true,
      })
    }

    return Array.from(map.values()).sort(
      (a, b) => Date.parse(b.timestampIso) - Date.parse(a.timestampIso),
    )
  }, [teamTasks, teamSessions, tasks, t, locale])

  const { scheduledTemplates, draftTemplates } = useMemo(() => {
    const sorted = [...teamTasks].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
    return {
      scheduledTemplates: sorted.filter(
        (x) => x.mode === 'scheduled' && !!x.cron,
      ),
      draftTemplates: sorted.filter(
        (x) => !(x.mode === 'scheduled' && !!x.cron),
      ),
    }
  }, [teamTasks])
  const hasAnyTemplate =
    scheduledTemplates.length + draftTemplates.length > 0

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
    if (input.mode === 'session' && team) {
      void startSessionFromTask(task, team)
    }
  }

  const play = (task: Task) => {
    if (!team) return
    void startSessionFromTask(task, team)
  }

  const openSession = (u: UnifiedSession) => {
    if (u.id && u.navigable && params?.companySlug && params?.teamSlug) {
      markSessionViewed(u.id)
      router.push(`/${params.companySlug}/${params.teamSlug}/s/${u.id}`)
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
          <div className="px-4 py-3 flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800">
            <div className="text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
              {t('tasks.templates') || '템플릿'}
            </div>
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="text-[12px] text-neutral-500 hover:text-neutral-900 inline-flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              {t('tasks.new')}
            </button>
          </div>

          {!hasAnyTemplate ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-neutral-400 text-[13px]">
              <div>{t('tasks.empty')}</div>
              <Button size="sm" variant="outline" onClick={() => setShowNew(true)}>
                <Plus className="w-3.5 h-3.5" />
                {t('tasks.new')}
              </Button>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {/* Drafts 먼저 (자주 쓰는 것) */}
              {draftTemplates.length > 0 && (
                <CollapsibleSection
                  icon={<FileText className="w-3.5 h-3.5" />}
                  label={t('tasks.drafts') || '드래프트'}
                  count={draftTemplates.length}
                  collapsed={collapsed.drafts}
                  onToggle={() => toggleSection('drafts')}
                >
                  {draftTemplates.map((task) => (
                    <TemplateRow
                      key={task.id}
                      task={task}
                      onRun={() => play(task)}
                      onEdit={() => selectTaskAsDraft(task.id)}
                    />
                  ))}
                </CollapsibleSection>
              )}
              {/* Scheduled 는 아래쪽. cron 동작하는 애들. */}
              {scheduledTemplates.length > 0 && (
                <CollapsibleSection
                  icon={<Clock className="w-3.5 h-3.5" />}
                  label={t('tasks.scheduled') || '스케줄'}
                  count={scheduledTemplates.length}
                  collapsed={collapsed.scheduled}
                  onToggle={() => toggleSection('scheduled')}
                  accent="amber"
                >
                  {scheduledTemplates.map((task) => (
                    <TemplateRow
                      key={task.id}
                      task={task}
                      onRun={() => play(task)}
                      onEdit={() => selectTaskAsDraft(task.id)}
                    />
                  ))}
                </CollapsibleSection>
              )}
            </div>
          )}
        </aside>

        {/* Session inbox */}
        <main className="flex-1 flex flex-col min-w-0">
          <div className="px-6 py-3 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <div className="text-[14px] font-medium text-neutral-900 dark:text-neutral-100">
              {t('tasks.sessions') || '세션'}
              <span className="ml-1.5 font-mono text-neutral-400">
                {unifiedSessions.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="inline-flex items-center gap-1.5 text-[13px] bg-neutral-900 text-white px-3 py-1.5 rounded-sm hover:bg-neutral-800"
            >
              <Sparkle className="w-3.5 h-3.5" />
              {t('tasks.startSession') || '새 세션'}
            </button>
          </div>

          {unifiedSessions.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-neutral-400 text-[13px]">
              <div>{t('tasks.sessionsEmpty') || '아직 세션이 없습니다'}</div>
              {draftTemplates[0] && (
                <Button size="sm" variant="outline" onClick={() => play(draftTemplates[0]!)}>
                  <Sparkle className="w-3.5 h-3.5" />
                  {draftTemplates[0]?.title}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800">
              {unifiedSessions.map((u) => (
                <SessionInboxRow
                  key={u.id ?? `${u.taskId}:${u.timestampIso}`}
                  session={u}
                  onOpen={() => openSession(u)}
                  onDelete={
                    u.id && u.state === 'idle'
                      ? () => removeSession(u.id as string)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </main>
      </div>

      <NewTaskModal open={showNew} onClose={() => setShowNew(false)} onSubmit={handleCreate} />
      <TaskDetailModal task={selectedTask} onClose={() => selectTask(null)} />
    </div>
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
  const accentBar =
    accent === 'amber'
      ? 'before:bg-amber-400'
      : 'before:bg-neutral-200 dark:before:bg-neutral-700'
  return (
    <section
      className={clsx(
        'relative border-t border-neutral-100 dark:border-neutral-800 first:border-t-0',
        'before:content-[""] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px]',
        accentBar,
      )}
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

function StateDot({ state }: { state: SessionState }) {
  if (state === 'working') {
    return (
      <span className="relative flex w-2 h-2 shrink-0" title="작업 중">
        <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-75" />
        <span className="relative rounded-full w-2 h-2 bg-emerald-500" />
      </span>
    )
  }
  if (state === 'waiting') {
    return (
      <span
        className="w-2 h-2 rounded-full bg-amber-500 shrink-0"
        title="답변 대기"
      />
    )
  }
  return <span className="w-2 h-2 rounded-full bg-neutral-300 shrink-0" title="대기" />
}

function StateLabel({ state }: { state: SessionState }) {
  if (state === 'working') return <span className="text-emerald-600">작업 중</span>
  if (state === 'waiting') return <span className="text-amber-600">답변 대기</span>
  return <span className="text-neutral-400">대기</span>
}

function TemplateRow({
  task,
  onRun,
  onEdit,
}: {
  task: Task
  onRun: () => void
  onEdit: () => void
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
      onClick={onEdit}
      onKeyDown={(e) => e.key === 'Enter' && onEdit()}
      className={clsx(
        'group px-4 py-2.5 cursor-pointer transition-colors',
        isScheduled
          ? 'hover:bg-amber-50/60 dark:hover:bg-amber-900/10'
          : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40',
      )}
    >
      <div className="flex items-center gap-2">
        {isScheduled ? (
          <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
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
          aria-label={t('tasks.session') || t('tasks.startSession') || 'Session'}
          title={t('tasks.session') || t('tasks.startSession') || 'Session'}
          className={clsx(
            'shrink-0 w-6 h-6 rounded-sm flex items-center justify-center transition-colors',
            'opacity-0 group-hover:opacity-100',
            isScheduled
              ? 'text-amber-600 hover:text-amber-700 hover:bg-amber-100/70 dark:hover:bg-amber-900/30'
              : 'text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800',
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

function SessionInboxRow({
  session,
  onOpen,
  onDelete,
}: {
  session: UnifiedSession
  onOpen: () => void
  onDelete?: () => void
}) {
  const t = useT()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="group px-6 py-3 hover:bg-white dark:hover:bg-neutral-900 cursor-pointer flex items-start gap-3"
    >
      <div className="pt-1.5">
        <StateDot state={session.state} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[14px] font-medium text-neutral-900 dark:text-neutral-100 truncate">
            {session.title}
          </span>
        </div>
        <div className="text-[13px] text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
          {session.preview || t('tasks.noSessionPreview') || '—'}
        </div>
      </div>
      <div className="shrink-0 text-right pt-0.5 flex items-start gap-2">
        <div>
          <div
            className="text-[11px] font-mono text-neutral-400"
            suppressHydrationWarning
          >
            {session.relTime}
          </div>
          <div className="text-[11px] mt-0.5">
            <StateLabel state={session.state} />
          </div>
        </div>
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            aria-label={t('tasks.delete')}
            className="w-6 h-6 rounded-sm text-neutral-300 hover:text-red-600 hover:bg-red-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Trash className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  )
}
