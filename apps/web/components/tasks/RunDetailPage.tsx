'use client'

import { ArrowLeft, FileText, Warning } from '@phosphor-icons/react'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { AskUserModal } from '@/components/modals/AskUserModal'
import { useT } from '@/lib/i18n'
import { postAnswer, type AskUserQuestion } from '@/lib/api/sessions'
import { useCurrentTeam } from '@/lib/stores/useAppStore'
import { useTasksStore } from '@/lib/stores/useTasksStore'
import { formatDuration, runElapsedMs } from './shared'

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
}

function fmtK(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function agentLabel(
  team: ReturnType<typeof useCurrentTeam>,
  nodeId: string | undefined,
): string {
  if (!nodeId) return 'agent'
  const a = team?.agents.find((x) => x.id === nodeId)
  return a?.role ?? a?.label ?? nodeId
}

function renderTranscriptEntry(
  e: TranscriptEntry,
  team: ReturnType<typeof useCurrentTeam>,
): string {
  switch (e.kind) {
    case 'goal':
      return `목표: ${String(e.text ?? '').slice(0, 240)}`
    case 'ask_user':
      return `${e.agent_role ?? 'lead'} → 유저에게 질문`
    case 'user_answer': {
      const r = typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '')
      return `유저 응답: ${r.slice(0, 200)}`
    }
    case 'tool_call': {
      const who = agentLabel(team, e.node_id)
      const tool = e.tool ?? 'tool'
      if (tool === 'delegate_to') {
        const assignee = e.args?.assignee as string | undefined
        return `${who} → ${assignee ?? '?'} 위임`
      }
      if (tool === 'run_skill_script') {
        const skill = e.args?.skill as string | undefined
        const script = e.args?.script as string | undefined
        return `${who} → 스킬 실행 ${skill ?? ''}${script ? '/' + String(script) : ''}`
      }
      if (tool === 'activate_skill') {
        return `${who} → 스킬 활성화 (${e.args?.name ?? '?'})`
      }
      if (tool === 'read_skill_file') {
        return `${who} → 파일 읽기 (${e.args?.path ?? '?'})`
      }
      return `${who} → ${tool}`
    }
    case 'agent_message': {
      const who = agentLabel(team, e.node_id)
      const txt = String(e.text ?? '')
      return `${who}: ${txt}`
    }
    default:
      return e.kind
  }
}

function fmtBytes(b: number | null): string {
  if (b == null) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

export function RunDetailPage() {
  // The URL segment is the session UUID — the permanent, canonical id for a
  // session. Everything on this page is keyed off it; the ephemeral client session id
  // and backend session_id are internal concerns we don't surface here.
  const params = useParams<{
    companySlug: string
    teamSlug: string
    sessionId: string
  }>()
  const router = useRouter()
  const t = useT()
  const team = useCurrentTeam()
  const tasks = useTasksStore((s) => s.tasks)
  const updateRun = useTasksStore((s) => s.updateRun)
  const id = params?.sessionId ?? null
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showAsk, setShowAsk] = useState(false)

  useEffect(() => {
    if (!id) {
      setSummary(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`)
        if (!res.ok) {
          if (!cancelled) {
            setSummary(null)
            setNotFound(true)
          }
          return
        }
        const data = (await res.json()) as SessionSummary
        if (cancelled) return
        setSummary(data)
      } catch {
        if (!cancelled) setSummary(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  // URL doesn't carry the task id any more — resolve the owning task by
  // finding the session that points at this session's backend session_id. Task row
  // is only used for the prompt/references header; we can live without it
  // when a direct-link arrives before tasks hydrate.
  const task =
    (summary?.session_id
      ? tasks.find((x) => x.sessions.some((r) => r.id === summary.session_id))
      : null) ?? null
  const session =
    task?.sessions.find((r) => r.id === summary?.session_id) ?? null
  const pendingAsk = session?.pendingAsk

  // 답변 대기 세션에 들어오면 바로 답변 UI 를 띄운다. 사용자가 "답변" 버튼을
  // 한 번 더 누르게 만들면 왜 페이지가 비어 보이는지 혼란스럽다.
  useEffect(() => {
    if (pendingAsk) setShowAsk(true)
  }, [pendingAsk?.toolCallId])

  const submitAnswers = async (answers: Record<string, string>) => {
    if (!pendingAsk || !session || !task) return
    try {
      await postAnswer(pendingAsk.toolCallId, { answers })
      updateRun(task.id, session.id, { pendingAsk: undefined })
    } catch (e) {
      console.error(e)
    } finally {
      setShowAsk(false)
    }
  }

  const skipAsk = async () => {
    if (!pendingAsk || !session || !task) return
    try {
      await postAnswer(pendingAsk.toolCallId, { skipped: true })
      updateRun(task.id, session.id, { pendingAsk: undefined })
    } catch (e) {
      console.error(e)
    } finally {
      setShowAsk(false)
    }
  }

  const backHref = params
    ? `/${params.companySlug}/${params.teamSlug}/tasks`
    : '/'

  if (loading && !summary) {
    return (
      <div className="h-full w-full flex items-center justify-center text-neutral-400 text-[14px]">
        로딩 중…
      </div>
    )
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

  const failed = summary.status === 'error'
  const durationMs = summary.finished_at
    ? summary.finished_at - summary.started_at
    : session
    ? runElapsedMs(session, Date.now())
    : 0
  const title = task?.title ?? summary.goal.split('\n')[0]?.slice(0, 80) ?? 'Session'
  const prompt = task?.prompt ?? summary.goal
  const references = task?.references ?? []
  const startedAtIso = new Date(summary.started_at).toISOString()
  const finishedAtIso = summary.finished_at ? new Date(summary.finished_at).toISOString() : null

  return (
    <div className="h-full w-full overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <div className="max-w-[960px] mx-auto px-6 py-6 space-y-6">
        {/* Top nav */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.push(backHref)}
            className="inline-flex items-center gap-1.5 text-[13px] text-neutral-500 hover:text-neutral-900"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t('tasks.backToList') || '태스크 목록'}
          </button>
          <div className="text-[11px] font-mono text-neutral-400">{summary.id}</div>
        </div>

        {/* Header */}
        <header className="space-y-2">
          <h1 className="text-[22px] font-semibold text-neutral-900 dark:text-neutral-100 leading-tight">
            {title}
          </h1>
          <div className="flex items-center gap-3 text-[13px] text-neutral-500 flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  failed ? 'bg-red-500' : 'bg-neutral-400'
                }`}
              />
              {summary.status || (failed ? 'failed' : 'done')}
            </span>
            <span className="font-mono">⏱ {formatDuration(durationMs)}</span>
            <span
              className="font-mono text-neutral-400"
              suppressHydrationWarning
            >
              {finishedAtIso
                ? `${startedAtIso} → ${finishedAtIso}`
                : `started ${startedAtIso}`}
            </span>
          </div>
        </header>

        {/* Failure banner */}
        {failed && summary.error && (
          <div className="rounded bg-red-50 border border-red-200 text-red-700 text-[14px] px-3 py-2 flex items-start gap-2">
            <Warning className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="whitespace-pre-wrap">{summary.error}</div>
          </div>
        )}

        {/* Prompt */}
        <section className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
            {t('tasks.fieldPrompt')}
          </div>
          <div className="px-4 py-3 text-[14px] text-neutral-900 dark:text-neutral-100 whitespace-pre-wrap leading-relaxed">
            {prompt}
          </div>
        </section>

        {/* References */}
        {references.length > 0 && (
          <section className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
              {t('tasks.fieldReferences')}
              <span className="ml-1 font-mono text-neutral-400">
                ({references.length})
              </span>
            </div>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {references.map((ref) => (
                <li key={ref.id} className="px-4 py-2.5 text-[13px]">
                  <div className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                    <span className="flex-1 truncate font-mono">{ref.name}</span>
                    <span className="text-[11px] text-neutral-400 font-mono">
                      {fmtBytes(ref.size)}
                    </span>
                  </div>
                  {ref.note && (
                    <div className="mt-1 ml-5 text-[12.5px] text-neutral-500 italic">
                      {ref.note}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Token usage */}
        {summary.usage && summary.usage.n > 0 && (
          <section className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
              {t('tasks.usageHeader') || '사용 토큰'}
            </div>
            <div className="px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-[13px] font-mono text-neutral-800 dark:text-neutral-200">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-400 mb-0.5">input</div>
                <div>{fmtK(summary.usage.input_tokens)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-400 mb-0.5">output</div>
                <div>{fmtK(summary.usage.output_tokens)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-400 mb-0.5">cache read</div>
                <div>{fmtK(summary.usage.cache_read)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-400 mb-0.5">cache write</div>
                <div>{fmtK(summary.usage.cache_write)}</div>
              </div>
              {summary.usage.cost_cents > 0 && (
                <div className="col-span-2 md:col-span-4 pt-2 border-t border-neutral-100 dark:border-neutral-800 flex justify-between">
                  <span className="text-[11px] uppercase tracking-wide text-neutral-400">cost</span>
                  <span>${(summary.usage.cost_cents / 100).toFixed(4)}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Artifacts */}
        {summary.artifacts.length > 0 && (
          <section className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
              {t('tasks.artifactsHeader') || '생성된 파일'}
              <span className="ml-1 font-mono text-neutral-400">
                ({summary.artifacts.length})
              </span>
            </div>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {summary.artifacts.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/api/artifacts/${encodeURIComponent(a.id)}/download`}
                    className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                    download
                  >
                    <FileText className="w-4 h-4 text-neutral-500 shrink-0" />
                    <span className="flex-1 truncate">{a.filename}</span>
                    {a.size != null && (
                      <span className="text-[11px] font-mono text-neutral-400">
                        {fmtBytes(a.size)}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Final output */}
        {summary.output && (
          <section className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
              {t('tasks.finalOutputHeader') || '최종 결과'}
            </div>
            <div className="px-4 py-3 text-[14px] text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap leading-relaxed">
              {summary.output}
            </div>
          </section>
        )}

        {/* Session trace */}
        {summary.transcript.length > 0 && (
          <section className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
              {t('tasks.runTraceHeader') || '수행 과정'}
            </div>
            <ol className="divide-y divide-neutral-100 dark:divide-neutral-800 text-[12.5px] font-mono text-neutral-700 dark:text-neutral-300">
              {summary.transcript.map((e, i) => (
                <li key={i} className="px-4 py-2 flex gap-3">
                  <span className="text-neutral-400 shrink-0 w-6 text-right">
                    {i + 1}.
                  </span>
                  <span className="flex-1 whitespace-pre-wrap break-words">
                    {renderTranscriptEntry(e, team)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* 답변 대기 배너 — AskUserModal 을 닫았을 때도 재진입 가능하게 */}
        {pendingAsk && !showAsk && (
          <section className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 flex items-center justify-between">
            <div className="text-[13px] text-amber-800">
              {t('tasks.answer') || '답변이 필요합니다'} ({pendingAsk.questions.length})
            </div>
            <button
              type="button"
              onClick={() => setShowAsk(true)}
              className="text-[13px] bg-amber-600 text-white px-3 py-1.5 rounded hover:bg-amber-700"
            >
              {t('tasks.answer') || '답변하기'}
            </button>
          </section>
        )}
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
