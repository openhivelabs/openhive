'use client'

import {
  ArrowLeft,
  ArrowUp,
  CaretDown,
  Coins,
  DownloadSimple,
  FileText,
  Paperclip,
  Plus,
  Sparkle,
  Warning,
  Wrench,
  X,
} from '@phosphor-icons/react'
import { useParams, useRouter } from 'next/navigation'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AskUserModal } from '@/components/modals/AskUserModal'
import { useT } from '@/lib/i18n'
import { postAnswer, type AskUserQuestion } from '@/lib/api/sessions'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useTasksStore } from '@/lib/stores/useTasksStore'

interface SessionArtifact {
  id: string
  filename: string
  size: number | null
  mime: string | null
}

interface SessionUsage {
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  cost_cents: number
  n: number
}

interface TranscriptEntry {
  kind: string
  ts?: number
  text?: string
  result?: unknown
  agent_role?: string
  questions?: unknown
  node_id?: string
  tool?: string
  args?: Record<string, unknown>
}

interface SessionSummary {
  id: string
  session_id: string
  goal: string
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  status: string
  artifacts: SessionArtifact[]
  transcript: TranscriptEntry[]
  usage: SessionUsage | null
  pending_ask: {
    toolCallId: string
    questions: unknown[]
    agentRole?: string
  } | null
}

function fmtK(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function fmtBytes(b: number | null): string {
  if (b == null) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

function agentLabel(
  team: ReturnType<typeof useCurrentTeam>,
  nodeId: string | undefined,
  fallback = 'agent',
): string {
  if (!nodeId) return fallback
  const a = team?.agents.find((x) => x.id === nodeId)
  return a?.role ?? a?.label ?? nodeId
}

type ChatItem =
  | { kind: 'user'; id: string; text: string; pending?: boolean }
  | {
      kind: 'assistant'
      id: string
      author: string
      text: string
    }
  | {
      kind: 'tool'
      id: string
      author: string
      summary: string
    }
  | { kind: 'error'; id: string; text: string }

function summarizeTool(e: TranscriptEntry): string {
  const tool = e.tool ?? 'tool'
  if (tool === 'delegate_to') {
    const assignee = e.args?.assignee as string | undefined
    return `${assignee ?? '?'} 에게 위임`
  }
  if (tool === 'run_skill_script') {
    const skill = e.args?.skill as string | undefined
    const script = e.args?.script as string | undefined
    return `스킬 실행 ${skill ?? ''}${script ? '/' + script : ''}`
  }
  if (tool === 'activate_skill') {
    return `스킬 활성화 (${e.args?.name ?? '?'})`
  }
  if (tool === 'read_skill_file') {
    return `파일 읽기 (${e.args?.path ?? '?'})`
  }
  return tool
}

function buildChat(
  summary: SessionSummary,
  team: ReturnType<typeof useCurrentTeam>,
): ChatItem[] {
  const out: ChatItem[] = []
  if (summary.goal) {
    out.push({ kind: 'user', id: 'goal', text: summary.goal })
  }
  summary.transcript.forEach((e, i) => {
    const id = `t-${i}`
    switch (e.kind) {
      case 'goal':
        // already rendered as the first user bubble
        break
      case 'agent_message': {
        const txt = String(e.text ?? '').trim()
        if (!txt) break
        out.push({
          kind: 'assistant',
          id,
          author: agentLabel(team, e.node_id, e.agent_role ?? 'agent'),
          text: txt,
        })
        break
      }
      case 'tool_call':
        out.push({
          kind: 'tool',
          id,
          author: agentLabel(team, e.node_id, e.agent_role ?? 'agent'),
          summary: summarizeTool(e),
        })
        break
      case 'ask_user':
        out.push({
          kind: 'assistant',
          id,
          author: e.agent_role ?? 'lead',
          text: '질문이 있습니다. 오른쪽에서 답변을 남겨주세요.',
        })
        break
      case 'user_answer': {
        const r =
          typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '')
        out.push({ kind: 'user', id, text: r })
        break
      }
      case 'user_message': {
        // Follow-up user message in a continuous chat session.
        const txt = String(e.text ?? '').trim()
        if (txt) out.push({ kind: 'user', id, text: txt })
        break
      }
      default:
        break
    }
  })
  if (summary.output) {
    // The session's "output" is just the latest assistant message from the
    // top-level agent — render it as a normal assistant bubble.
    out.push({
      kind: 'assistant',
      id: 'final',
      author: team?.agents[0]?.role ?? 'lead',
      text: summary.output,
    })
  }
  if (summary.error) {
    out.push({ kind: 'error', id: 'error', text: summary.error })
  }
  return out
}

export function RunDetailPage() {
  const params = useParams<{
    companySlug: string
    teamSlug: string
    sessionId: string
  }>()
  const router = useRouter()
  const t = useT()
  const team = useCurrentTeam()
  // Left sidebar (TeamPanel) is 220px expanded / 52px collapsed; right
  // artifacts aside is fixed at 272px. To keep the chat column centered to
  // the viewport regardless of collapse state, we pad the chat column's
  // left by the difference (168px) when the team panel is collapsed.
  const teamPanelCollapsed = useAppStore((s) => s.teamPanelCollapsed)
  const chatColOffsetPx = teamPanelCollapsed ? 168 : 0
  const tasks = useTasksStore((s) => s.tasks)
  const id = params?.sessionId ?? null
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showAsk, setShowAsk] = useState(false)
  const [sending, setSending] = useState(false)
  const [pendingUserMessages, setPendingUserMessages] = useState<
    { id: string; text: string }[]
  >(() => {
    // Seed from NewChatPage handoff: the user's first message was typed there
    // but the session only exists now. Without this, the bubble briefly
    // disappears between /new navigation and the first summary fetch.
    if (typeof window === 'undefined' || !params?.sessionId) return []
    try {
      const key = `openhive:pending:${params.sessionId}`
      const text = sessionStorage.getItem(key)
      if (text) {
        sessionStorage.removeItem(key)
        return [{ id: `handoff-${Date.now()}`, text }]
      }
    } catch {
      /* sessionStorage unavailable */
    }
    return []
  })
  const [sendError, setSendError] = useState<string | null>(null)
  // True only while the AI is actively producing output in the current turn.
  // Flips on node_started/token/tool_call/ask_user, off on turn_finished/
  // run_finished/run_error. A chat session parks in running status between
  // turns, so we can't use summary.status for the spinner.
  const [aiActive, setAiActive] = useState(false)

  useEffect(() => {
    if (!id) {
      setSummary(null)
      setLoading(false)
      setAiActive(false)
      return
    }
    let cancelled = false
    let es: EventSource | null = null
    let refetchTimer: ReturnType<typeof setTimeout> | null = null
    let inflight = false
    // If events arrive while a fetch is inflight, set this so we kick off
    // one more fetch when the current one resolves — otherwise late events
    // (tokens after the first refetch started) never get reflected.
    let dirty = false
    setAiActive(false)

    const fetchSummary = async () => {
      if (cancelled) return
      if (inflight) {
        dirty = true
        return
      }
      inflight = true
      dirty = false
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`)
        if (!res.ok) {
          if (!cancelled) {
            if (res.status === 404) setNotFound(true)
          }
          return
        }
        const data = (await res.json()) as SessionSummary
        if (!cancelled) setSummary(data)
      } catch {
        /* transient — will refetch on next event */
      } finally {
        inflight = false
        if (!cancelled) setLoading(false)
        if (dirty && !cancelled) {
          dirty = false
          void fetchSummary()
        }
      }
    }

    const scheduleRefetch = () => {
      if (refetchTimer) return
      refetchTimer = setTimeout(() => {
        refetchTimer = null
        void fetchSummary()
      }, 60)
    }

    setLoading(true)
    setNotFound(false)

    void fetchSummary().then(() => {
      if (cancelled) return
      es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream`)
      es.onmessage = (ev) => {
        if (ev.data === '[DONE]') {
          es?.close()
          es = null
          setAiActive(false)
          void fetchSummary()
          return
        }
        try {
          const evt = JSON.parse(ev.data) as { kind?: string }
          switch (evt.kind) {
            case 'run_started':
            case 'node_started':
            case 'token':
            case 'tool_call':
              setAiActive(true)
              break
            case 'turn_finished':
            case 'run_finished':
            case 'run_error':
            case 'ask_user':
            case 'user_question':
              setAiActive(false)
              break
            case 'user_message':
              // New user input kicks off the next turn; the matching
              // node_started will flip aiActive on immediately after.
              break
          }
        } catch {
          /* non-JSON frame (shouldn't happen) */
        }
        scheduleRefetch()
      }
      es.onerror = () => {
        // EventSource fires onerror on transient hiccups too (the browser is
        // about to auto-reconnect — readyState === CONNECTING). Only tear
        // down when the connection is permanently closed; otherwise
        // previously we killed the subscription on the first blip and the
        // user had to hard-refresh to see any further AI output.
        if (es && es.readyState === EventSource.CLOSED) {
          es = null
          // Connection is gone for good — do a final refetch so any events
          // that arrived during the teardown are reflected.
          void fetchSummary()
        }
      }
    })

    return () => {
      cancelled = true
      if (refetchTimer) clearTimeout(refetchTimer)
      if (es) es.close()
    }
  }, [id])

  // 드래프트/세션 분리 이후 session 은 sessions store 의 1급 레코드로 관리됨.
  // 이 화면의 데이터 소스는 서버 summary — task 참조는 오직 화면 컨텍스트
  // (제목/참고자료 등) 용도. pendingAsk 는 서버 summary 를 truth 로 사용한다.
  const task =
    (summary?.session_id
      ? tasks.find((x) => x.sessions.some((r) => r.id === summary.session_id))
      : null) ?? null
  const pendingAsk = summary?.pending_ask ?? null

  useEffect(() => {
    if (pendingAsk) setShowAsk(true)
  }, [pendingAsk?.toolCallId])

  const submitAnswers = async (answers: Record<string, string>) => {
    if (!pendingAsk) return
    try {
      await postAnswer(pendingAsk.toolCallId, { answers })
      setSummary((prev) => (prev ? { ...prev, pending_ask: null } : prev))
    } catch (e) {
      console.error(e)
    } finally {
      setShowAsk(false)
    }
  }

  const skipAsk = async () => {
    if (!pendingAsk) return
    try {
      await postAnswer(pendingAsk.toolCallId, { skipped: true })
      setSummary((prev) => (prev ? { ...prev, pending_ask: null } : prev))
    } catch (e) {
      console.error(e)
    } finally {
      setShowAsk(false)
    }
  }

  const chat = useMemo(() => {
    if (!summary) {
      // Summary hasn't loaded yet — still render handoff pending bubbles so
      // the message stays visible across the /new → /s/{id} transition.
      return pendingUserMessages.map((m) => ({
        kind: 'user' as const,
        id: m.id,
        text: m.text,
        pending: true,
      }))
    }
    const base = buildChat(summary, team)
    // Drop pending bubbles whose text already appears as goal or user_message
    // in the transcript — avoids duplicates once the server catches up.
    const serverTexts = new Set<string>()
    if (summary.goal) serverTexts.add(summary.goal.trim())
    for (const e of summary.transcript) {
      if (e.kind === 'user_message' || e.kind === 'goal') {
        const t = String(e.text ?? '').trim()
        if (t) serverTexts.add(t)
      }
    }
    for (const m of pendingUserMessages) {
      if (serverTexts.has(m.text.trim())) continue
      base.push({ kind: 'user', id: m.id, text: m.text, pending: true })
    }
    return base
  }, [summary, team, pendingUserMessages])

  // Once the server transcript catches up with a pending bubble, drop it
  // from state so it doesn't linger as a stale entry.
  useEffect(() => {
    if (!summary || pendingUserMessages.length === 0) return
    const serverTexts = new Set<string>()
    if (summary.goal) serverTexts.add(summary.goal.trim())
    for (const e of summary.transcript) {
      if (e.kind === 'user_message' || e.kind === 'goal') {
        const t = String(e.text ?? '').trim()
        if (t) serverTexts.add(t)
      }
    }
    const next = pendingUserMessages.filter(
      (m) => !serverTexts.has(m.text.trim()),
    )
    if (next.length !== pendingUserMessages.length) {
      setPendingUserMessages(next)
    }
  }, [summary, pendingUserMessages])

  async function sendMessage(raw: string) {
    const text = raw.trim()
    if (!text || !id || sending) return
    const localId = `pending-${Date.now()}`
    // Force the optimistic bubble to paint this frame — otherwise React
    // batches these sets with the subsequent setSummary/refetch work and
    // the user perceives a ~1s gap before their message appears.
    flushSync(() => {
      setPendingUserMessages((prev) => [...prev, { id: localId, text }])
      setSending(true)
      setSendError(null)
    })
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Re-fetch summary so the pending message is replaced by the real
      // transcript entry, and any new agent reply shows up.
      const refreshed = await fetch(
        `/api/sessions/${encodeURIComponent(id)}`,
      )
      if (refreshed.ok) {
        const data = (await refreshed.json()) as SessionSummary
        setSummary(data)
      }
      setPendingUserMessages((prev) => prev.filter((m) => m.id !== localId))
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'send failed')
      // Keep the optimistic bubble so the user can see what they tried to send.
    } finally {
      setSending(false)
    }
  }

  // Auto-scroll chat to bottom whenever new items arrive
  const chatEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [chat.length])

  const backHref = params
    ? `/${params.companySlug}/${params.teamSlug}/tasks`
    : '/'

  if (loading && !summary) {
    return <div className="h-full w-full bg-neutral-50 dark:bg-neutral-950" />
  }

  if (notFound || !summary) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-3 text-neutral-500 text-[14px]">
        <div>해당 실행 기록을 찾을 수 없습니다.</div>
        <button
          type="button"
          onClick={() => router.push(backHref)}
          className="text-neutral-900 underline"
        >
          태스크 목록으로
        </button>
      </div>
    )
  }

  // Show the "진행 중…" spinner only when the AI is actively generating.
  // A chat session's server-side status stays 'running' while idle between
  // turns, so we drive this from live engine events instead.
  const running = aiActive && !pendingAsk
  const title = task?.title ?? summary.goal.split('\n')[0]?.slice(0, 80) ?? 'Session'
  const references = task?.references ?? []

  return (
    <div className="h-full w-full flex flex-col bg-neutral-50 dark:bg-neutral-950">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 h-12 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => router.push(backHref)}
            aria-label={t('tasks.backToList')}
            title={t('tasks.backToList')}
            className="inline-flex items-center justify-center w-7 h-7 rounded text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100 truncate">
            {title}
          </h1>
        </div>
      </div>

      {/* Pending ask banner */}
      {pendingAsk && !showAsk && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
          <div className="text-[13px] text-amber-800">
            {t('session.waitingForInput')} ({pendingAsk.questions.length})
          </div>
          <button
            type="button"
            onClick={() => setShowAsk(true)}
            className="text-[12px] bg-amber-600 text-white px-2.5 py-1 rounded hover:bg-amber-700"
          >
            {t('session.answerCta')}
          </button>
        </div>
      )}

      {/* Split: chat | artifacts */}
      <div className="flex-1 min-h-0 flex">
        {/* Chat column — scroll area + composer are regular flex children so
         *  the scrollbar never sits behind the input. paddingLeft keeps the
         *  chat centered to the viewport when the left sidebar collapses. */}
        <div
          className="flex-1 min-w-0 flex flex-col transition-[padding]"
          style={{ paddingLeft: chatColOffsetPx }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-quiet">
            <div className="max-w-[760px] mx-auto px-6 pt-6 pb-4 space-y-4">
              {chat.map((item) => (
                <ChatBubble key={item.id} item={item} />
              ))}
              {running && (
                <div className="flex items-center gap-2 text-[12px] text-neutral-400 px-1">
                  <Sparkle className="w-3.5 h-3.5 animate-pulse" />
                  <span>진행 중…</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          </div>
          <div className="shrink-0 px-6 pb-4">
            <div className="max-w-[760px] mx-auto">
              {sendError && (
                <div className="mb-2 text-[12px] text-red-600">
                  메시지 전송 실패: {sendError}
                </div>
              )}
              <Composer sending={sending} onSend={sendMessage} />
            </div>
          </div>
        </div>

        {/* Artifacts column */}
        <aside className="w-[272px] shrink-0 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-quiet px-3 py-4 space-y-3">
            {/* Artifacts */}
            <SidePanel
              icon={<FileText className="w-4 h-4" />}
              title={t('session.artifactsTitle')}
              count={summary.artifacts.length}
            >
              {summary.artifacts.length === 0 ? (
                <EmptyNote>{t('session.artifactsEmpty')}</EmptyNote>
              ) : (
                <ul className="space-y-0.5">
                  {summary.artifacts.map((a) => (
                    <li key={a.id}>
                      <a
                        href={`/api/artifacts/${encodeURIComponent(a.id)}/download`}
                        download
                        className="group flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                      >
                        <FileText className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span className="flex-1 truncate">{a.filename}</span>
                        <span className="text-[11px] font-mono text-neutral-400 shrink-0">
                          {fmtBytes(a.size)}
                        </span>
                        <DownloadSimple className="w-3.5 h-3.5 text-neutral-400 opacity-0 group-hover:opacity-100 shrink-0" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </SidePanel>

            {/* References */}
            <SidePanel
              icon={<Paperclip className="w-4 h-4" />}
              title={t('session.referencesTitle')}
              count={references.length}
            >
              {references.length === 0 ? (
                <EmptyNote>{t('session.referencesEmpty')}</EmptyNote>
              ) : (
                <ul className="space-y-0.5">
                  {references.map((ref) => (
                    <li
                      key={ref.id}
                      className="px-2 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                    >
                      <div className="flex items-center gap-2 text-[13px] text-neutral-700 dark:text-neutral-300">
                        <FileText className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span className="flex-1 truncate">{ref.name}</span>
                        <span className="text-[11px] text-neutral-400 font-mono shrink-0">
                          {fmtBytes(ref.size)}
                        </span>
                      </div>
                      {ref.note && (
                        <div className="mt-0.5 ml-5 text-[11.5px] text-neutral-500 italic leading-snug">
                          {ref.note}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </SidePanel>

            {/* Usage */}
            <SidePanel
              icon={<Coins className="w-4 h-4" />}
              title={t('session.usageTitle')}
            >
              {!summary.usage || summary.usage.n === 0 ? (
                <EmptyNote>{t('session.usageEmpty')}</EmptyNote>
              ) : (
                <div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <TokenStat label="in" value={fmtK(summary.usage.input_tokens)} />
                    <TokenStat label="out" value={fmtK(summary.usage.output_tokens)} />
                    <TokenStat label="cache read" value={fmtK(summary.usage.cache_read)} />
                    <TokenStat label="cache write" value={fmtK(summary.usage.cache_write)} />
                  </div>
                  {summary.usage.cost_cents > 0 && (
                    <div className="mt-3 pt-3 border-t border-neutral-200/70 dark:border-neutral-800/70 flex items-baseline justify-between">
                      <span className="text-[12px] text-neutral-500">
                        {t('session.costLabel')}
                      </span>
                      <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-100 font-mono">
                        ${(summary.usage.cost_cents / 100).toFixed(4)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </SidePanel>
          </div>
        </aside>
      </div>

      <AskUserModal
        open={showAsk && !!pendingAsk}
        questions={(pendingAsk?.questions as AskUserQuestion[]) ?? []}
        agentRole={pendingAsk?.agentRole}
        onSubmit={submitAnswers}
        onSkip={skipAsk}
      />
    </div>
  )
}

function SidePanel({
  icon,
  title,
  count,
  collapsible = true,
  defaultOpen = true,
  children,
}: {
  icon: ReactNode
  title: string
  count?: number
  collapsible?: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const expanded = collapsible ? open : true
  return (
    <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/50 px-3.5 py-3">
      <header
        className={`flex items-center gap-2 ${expanded ? 'mb-2.5' : ''} ${
          collapsible ? 'cursor-pointer select-none' : ''
        }`}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        role={collapsible ? 'button' : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        tabIndex={collapsible ? 0 : undefined}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpen((v) => !v)
                }
              }
            : undefined
        }
      >
        <span className="text-neutral-500 dark:text-neutral-400">{icon}</span>
        <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-200">
          {title}
        </span>
        {typeof count === 'number' && count > 0 && (
          <span className="text-[11px] font-mono text-neutral-400 tabular-nums">
            {count}
          </span>
        )}
        {collapsible && (
          <CaretDown
            className={`ml-auto w-3.5 h-3.5 text-neutral-400 transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
          />
        )}
      </header>
      {expanded && (
        <div className="max-h-[320px] overflow-y-auto scrollbar-quiet">
          {children}
        </div>
      )}
    </section>
  )
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="text-[12.5px] text-neutral-400 leading-relaxed">
      {children}
    </div>
  )
}

function TokenStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11.5px] text-neutral-500 dark:text-neutral-400">
        {label}
      </span>
      <span className="text-[13px] font-mono tabular-nums text-neutral-900 dark:text-neutral-100">
        {value}
      </span>
    </div>
  )
}

interface Attachment {
  id: string
  file: File
}

function readFileAsText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const r = reader.result
      resolve(typeof r === 'string' ? r : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsText(file)
  })
}

function isLikelyText(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  const textishExt = /\.(md|txt|csv|tsv|json|ya?ml|toml|ini|log|xml|html?|css|js|tsx?|jsx?|py|rb|go|rs|java|sh|sql)$/i
  return textishExt.test(file.name)
}

function fmtFileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Isolated composer — holds its own text state so typing doesn't re-render
 *  the whole chat (markdown rendering on every keystroke was the source of
 *  the "text appears half a beat late" feel). */
const Composer = memo(function Composer({
  sending,
  onSend,
}: {
  sending: boolean
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const disabled = sending || (!text.trim() && attachments.length === 0)

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const next: Attachment[] = []
    for (const f of Array.from(files)) {
      next.push({ id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`, file: f })
    }
    setAttachments((prev) => [...prev, ...next])
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const submit = async () => {
    const body = text.trim()
    if (sending) return
    if (!body && attachments.length === 0) return

    // Inline attachments into the message so the backend POST stays simple —
    // text files get their content, binaries get a short marker.
    const parts: string[] = []
    if (body) parts.push(body)
    for (const a of attachments) {
      if (isLikelyText(a.file)) {
        const content = await readFileAsText(a.file)
        parts.push(
          `--- 첨부파일: ${a.file.name} (${fmtFileSize(a.file.size)}) ---\n${content ?? ''}`,
        )
      } else {
        parts.push(
          `--- 첨부파일: ${a.file.name} (${fmtFileSize(a.file.size)}, 바이너리) ---`,
        )
      }
    }
    const combined = parts.join('\n\n')
    if (!combined.trim()) return

    onSend(combined)
    setText('')
    setAttachments([])
  }

  return (
    <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 pt-2.5 pb-2 focus-within:border-neutral-400 dark:focus-within:border-neutral-600">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-neutral-100 dark:bg-neutral-800 text-[12px] text-neutral-700 dark:text-neutral-300"
            >
              <FileText className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
              <span className="max-w-[180px] truncate">{a.file.name}</span>
              <span className="text-[10.5px] font-mono text-neutral-400 shrink-0">
                {fmtFileSize(a.file.size)}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                aria-label="첨부 제거"
                className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder="메시지를 입력하세요…"
        rows={1}
        className="w-full resize-none bg-transparent text-[15.5px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 outline-none max-h-60 py-0.5 leading-relaxed"
      />

      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="파일 첨부"
            title="파일 첨부"
            className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Plus className="w-[18px] h-[18px]" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled}
          className="shrink-0 w-8 h-8 rounded-full bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:bg-neutral-800 dark:hover:bg-neutral-200"
          aria-label="전송"
        >
          <ArrowUp className="w-[18px] h-[18px]" />
        </button>
      </div>
    </div>
  )
})

function Markdown({ text }: { text: string }) {
  // Terse chat-friendly prose styling. Headings are dialed down (h1/h2 look
  // oversized in a bubble), lists keep their markers, code blocks get a
  // subtle surface, links are underlined on hover.
  return (
    <div className="space-y-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-[19px] font-semibold mt-3 mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[17.5px] font-semibold mt-3 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[16px] font-semibold mt-2.5 mb-1.5">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-[15.5px] font-semibold mt-2 mb-1">{children}</h4>
          ),
          p: ({ children }) => (
            <p className="text-[15.5px] leading-relaxed">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 space-y-1 text-[15.5px]">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 space-y-1 text-[15.5px]">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-blue-600"
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = (props as { node?: { tagName?: string } }).node?.tagName
            void isBlock
            const inline = !className
            if (inline) {
              return (
                <code className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-[14px]">
                  {children}
                </code>
              )
            }
            return (
              <code className={`font-mono text-[14px] ${className ?? ''}`}>
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-neutral-100 dark:bg-neutral-800 p-3.5 text-[14px] font-mono leading-relaxed">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-neutral-300 dark:border-neutral-700 pl-3 text-neutral-600 dark:text-neutral-400">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-neutral-200 dark:border-neutral-800 my-3" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="text-[14.5px] border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-neutral-200 dark:border-neutral-800 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-neutral-200 dark:border-neutral-800 px-2 py-1">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className={`max-w-[80%] rounded-2xl rounded-br-sm bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100 px-4 py-3 text-[15.5px] whitespace-pre-wrap leading-relaxed ${
            item.pending ? 'opacity-60' : ''
          }`}
        >
          {item.text}
        </div>
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="text-[15.5px] text-neutral-900 dark:text-neutral-100 leading-relaxed">
        <Markdown text={item.text} />
      </div>
    )
  }
  if (item.kind === 'tool') {
    return (
      <div className="px-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-800 bg-neutral-100/60 dark:bg-neutral-900/60 px-2.5 py-1 text-[12px] text-neutral-500 font-mono">
          <Wrench className="w-3 h-3" />
          <span className="text-neutral-700 dark:text-neutral-300">
            {item.summary}
          </span>
        </div>
      </div>
    )
  }
  // error
  return (
    <div className="flex gap-2.5">
      <div className="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center shrink-0">
        <Warning className="w-3.5 h-3.5 text-red-600" />
      </div>
      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-sm bg-red-50 border border-red-200 text-red-700 px-3.5 py-2.5 text-[13px] whitespace-pre-wrap leading-relaxed">
        {item.text}
      </div>
    </div>
  )
}
