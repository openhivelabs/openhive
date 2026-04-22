import {
  FilePlus,
  FileText,
  PencilSimple,
  Play,
  Question,
  Stop,
  Trash,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { AskUserModal } from '@/components/modals/AskUserModal'
import { readAsReference } from '@/components/modals/referenceUpload'
import { type AskUserQuestion, postAnswer } from '@/lib/api/sessions'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { useCurrentTeam } from '@/lib/stores/useAppStore'
import { useTasksStore } from '@/lib/stores/useTasksStore'
import type { Task, TaskReference } from '@/lib/types'
import { Button } from '../ui/Button'
import { formatDuration, runElapsedMs, useTicker } from './shared'

interface TaskDetailModalProps {
  task: Task | null
  onClose: () => void
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
  e: {
    kind: string
    text?: string
    result?: unknown
    agent_role?: string
    tool?: string
    node_id?: string
    args?: Record<string, unknown>
  },
  team: ReturnType<typeof useCurrentTeam>,
): string {
  switch (e.kind) {
    case 'goal':
      return `목표: ${String(e.text ?? '').slice(0, 160)}`
    case 'ask_user':
      return `${e.agent_role ?? 'lead'} → 유저에게 질문`
    case 'user_answer': {
      const r = typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '')
      return `유저 응답: ${r.slice(0, 120)}`
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
      const txt = String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 160)
      return `${who}: ${txt}`
    }
    default:
      return e.kind
  }
}

interface SessionArtifact {
  id: string
  filename: string
  size: number | null
  mime: string | null
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

interface SessionUsage {
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  cost_cents: number
  n: number
}

interface SessionSummary {
  output: string | null
  artifacts: SessionArtifact[]
  transcript: TranscriptEntry[]
  status: string
  usage: SessionUsage | null
}

function fmtK(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export function TaskDetailModal({ task, onClose }: TaskDetailModalProps) {
  const t = useT()
  const team = useCurrentTeam()
  const startSessionFromTask = useTasksStore((s) => s.startSessionFromTask)
  const stopSession = useTasksStore((s) => s.stopSession)
  const updateRun = useTasksStore((s) => s.updateRun)
  const updateTask = useTasksStore((s) => s.updateTask)
  const removeTask = useTasksStore((s) => s.removeTask)
  const [showAsk, setShowAsk] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedSessionId = useTasksStore((s) => s.selectedSessionId)
  const selectedAsDraft = useTasksStore((s) => s.selectedAsDraft)

  useEscapeClose(task, onClose)

  // If the user opened a specific session card (Running/Done column), honor that
  // choice — otherwise multiple session cards for the same task would all collapse
  // to the same "latest" session, and per-session output/artifacts look blank.
  // Fallback heuristic: prefer an active session (pending ask, then running, then
  // needs_input) over array-last, since concurrent sessions can leave a short-lived
  // cancel/done at the end that masks a still-active older session.
  const pickedRun = task && selectedSessionId
    ? task.sessions.find((r) => r.id === selectedSessionId)
    : undefined
  const latest = pickedRun
    ?? (task
      ? task.sessions.find((r) => r.status === 'running' && r.pendingAsk) ??
        task.sessions.find((r) => r.status === 'running') ??
        task.sessions.find((r) => r.status === 'needs_input') ??
        task.sessions[task.sessions.length - 1]
      : undefined)
  const pendingAsk = latest?.pendingAsk

  // Auto-surface the answer UI only when the user explicitly opened a
  // specific session (selectedSessionId set) — e.g. clicked a 답변 대기
  // card in the inbox. Opening the modal via template-edit must NOT auto-
  // pop the question dialog; the user is editing the template, not trying
  // to answer the Lead.
  useEffect(() => {
    if (pendingAsk && selectedSessionId) setShowAsk(true)
  }, [pendingAsk?.toolCallId, selectedSessionId])

  // For sessions that have ended (done / failed — failed includes user-cancelled
  // and server-interrupted, see error field), pull the final
  // Lead output + any generated artifacts from the session store so each
  // done card shows that session's unique deliverable. Re-fetched per session so
  // switching cards doesn't leak previous data.
  const endedSessionId =
    latest && latest.status !== 'running' && latest.id
      ? latest.id
      : null
  useEffect(() => {
    if (!endedSessionId) {
      setSummary(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [sess, arts] = await Promise.all([
          fetch(`/api/sessions?session_id=${encodeURIComponent(endedSessionId)}`).then((r) =>
            r.ok ? r.json() : null,
          ),
          fetch(`/api/artifacts?session_id=${encodeURIComponent(endedSessionId)}`).then((r) =>
            r.ok ? r.json() : [],
          ),
        ])
        if (cancelled) return
        setSummary({
          output: sess?.output ?? null,
          artifacts: Array.isArray(arts) ? arts : [],
          transcript: Array.isArray(sess?.transcript) ? sess.transcript : [],
          status: sess?.status ?? '',
          usage: sess?.usage ?? null,
        })
      } catch {
        if (!cancelled) setSummary(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [endedSessionId])
  const isRunning = latest?.status === 'running' || latest?.status === 'needs_input'
  const now = useTicker(isRunning && !!latest && !latest.endedAt)
  const elapsedMs = latest ? runElapsedMs(latest, now) : 0

  if (!task) return null

  const startEdit = () => {
    setPromptDraft(task.prompt)
    setEditingPrompt(true)
  }

  const savePrompt = () => {
    const next = promptDraft.trim()
    if (next && next !== task.prompt) {
      updateTask(task.id, { prompt: next })
    }
    setEditingPrompt(false)
  }

  const cancelEdit = () => {
    setEditingPrompt(false)
    setPromptDraft('')
  }

  const addReferences = async (files: FileList | null) => {
    if (!files) return
    const picked: TaskReference[] = []
    for (const f of Array.from(files)) picked.push(await readAsReference(f))
    updateTask(task.id, { references: [...task.references, ...picked] })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeReference = (refId: string) => {
    updateTask(task.id, { references: task.references.filter((r) => r.id !== refId) })
  }

  const submitAnswers = async (answers: Record<string, string>) => {
    if (!pendingAsk || !latest) return
    try {
      await postAnswer(pendingAsk.toolCallId, { answers })
      updateRun(task.id, latest.id, { pendingAsk: undefined })
    } catch (e) {
      console.error(e)
    } finally {
      setShowAsk(false)
    }
  }

  const skipAsk = async () => {
    if (!pendingAsk || !latest) return
    try {
      await postAnswer(pendingAsk.toolCallId, { skipped: true })
      updateRun(task.id, latest.id, { pendingAsk: undefined })
    } catch (e) {
      console.error(e)
    } finally {
      setShowAsk(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[760px] max-w-[94vw] max-h-[88vh] rounded-md bg-white shadow-xl border border-neutral-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-200 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-semibold text-neutral-900">{task.title}</div>
            <div className="text-[13px] text-neutral-500 mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{t(task.mode === 'scheduled' ? 'tasks.status.scheduled' : 'tasks.status.draft')}</span>
              {latest && (
                <span
                  className="font-mono text-neutral-600"
                  suppressHydrationWarning
                  title={
                    latest.endedAt
                      ? `${latest.startedAt} → ${latest.endedAt}`
                      : `started ${latest.startedAt}`
                  }
                >
                  {latest.endedAt ? '⏱ ' : '⏱ '}
                  {formatDuration(elapsedMs)}
                </span>
              )}
              {task.mode === 'scheduled' && task.cron && (
                <span className="font-mono">⏰ {task.cron}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('tasks.close')}
            className="p-1 rounded hover:bg-neutral-100 text-neutral-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Prompt (editable) */}
          <div className="px-4 py-3 border-b border-neutral-200 bg-neutral-50">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
                {t('tasks.fieldPrompt')}
              </div>
              {!editingPrompt && (
                <button
                  type="button"
                  onClick={startEdit}
                  className="inline-flex items-center gap-1 text-[12px] text-neutral-500 hover:text-neutral-900"
                >
                  <PencilSimple className="w-3 h-3" />
                  {t('tasks.edit')}
                </button>
              )}
            </div>
            {editingPrompt ? (
              <div className="space-y-2">
                <textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  rows={5}
                  className="w-full px-2.5 py-2 text-[15px] rounded-sm border border-neutral-300 bg-white resize-none"
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={cancelEdit}>
                    {t('tasks.cancel')}
                  </Button>
                  <Button size="sm" variant="primary" onClick={savePrompt}>
                    {t('settings.save')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-[15px] text-neutral-900 whitespace-pre-wrap leading-relaxed">
                {task.prompt}
              </div>
            )}
          </div>

          {/* References */}
          <div className="px-4 py-3 border-b border-neutral-200">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500">
                {t('tasks.fieldReferences')}
                {task.references.length > 0 && (
                  <span className="ml-1 font-mono text-neutral-400">({task.references.length})</span>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => void addReferences(e.target.files)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 text-[12px] text-neutral-500 hover:text-neutral-900"
              >
                <FilePlus className="w-3 h-3" />
                {t('tasks.addReference')}
              </button>
            </div>
            {task.references.length === 0 ? (
              <div className="text-[13px] text-neutral-400 py-2">
                {t('tasks.noReferences')}
              </div>
            ) : (
              <div className="space-y-1.5">
                {task.references.map((ref) => (
                  <div
                    key={ref.id}
                    className="bg-neutral-50 border border-neutral-200 rounded-sm px-2 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                      <span className="flex-1 text-[13px] truncate font-mono">{ref.name}</span>
                      <span className="text-[11px] text-neutral-400 font-mono shrink-0">
                        {formatBytes(ref.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeReference(ref.id)}
                        aria-label={t('tasks.removeReference')}
                        className="p-0.5 rounded text-neutral-400 hover:text-red-600 hover:bg-red-50"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={ref.note ?? ''}
                      onChange={(e) =>
                        updateTask(task.id, {
                          references: task.references.map((r) =>
                            r.id === ref.id ? { ...r, note: e.target.value } : r,
                          ),
                        })
                      }
                      placeholder={t('tasks.referenceNotePlaceholder')}
                      className="mt-1 w-full px-2 py-1 text-[12px] rounded-sm border border-neutral-200 bg-white focus:border-neutral-400 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Failure reason (if any) */}
          {latest?.status === 'failed' && latest.error && (
            <div className="px-4 py-3">
              <div className="rounded bg-red-50 border border-red-200 text-red-700 text-[14px] px-2.5 py-2">
                <Warning className="inline w-3.5 h-3.5 mr-1" />
                {latest.error}
              </div>
            </div>
          )}

          {/* Session result — unique per session. Pulled from sessions/{id}/:
              generated files, the Lead's final output, and a distilled
              trace of what each agent actually did during the session. The
              trace makes each card visually distinct even for failed /
              stopped sessions where no artifact or output was produced. */}
          {!selectedAsDraft && endedSessionId && summary && (
            <div className="px-4 py-3 border-t border-neutral-200 space-y-3">
              {summary.usage && summary.usage.n > 0 && (
                <div>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
                    {t('tasks.usageHeader') || '사용 토큰'}
                  </div>
                  <div className="rounded bg-neutral-50 border border-neutral-200 px-3 py-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] font-mono text-neutral-700">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">input</span>
                      <span>{fmtK(summary.usage.input_tokens)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">output</span>
                      <span>{fmtK(summary.usage.output_tokens)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">cache read</span>
                      <span>{fmtK(summary.usage.cache_read)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">cache write</span>
                      <span>{fmtK(summary.usage.cache_write)}</span>
                    </div>
                    {summary.usage.cost_cents > 0 && (
                      <div className="col-span-2 flex justify-between pt-1 border-t border-neutral-200">
                        <span className="text-neutral-500">cost</span>
                        <span>${(summary.usage.cost_cents / 100).toFixed(4)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {summary.artifacts.length > 0 && (
                <div>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
                    {t('tasks.artifactsHeader') || '생성된 파일'}
                  </div>
                  <div className="space-y-1">
                    {summary.artifacts.map((a) => (
                      <a
                        key={a.id}
                        href={`/api/artifacts/${encodeURIComponent(a.id)}/download`}
                        className="flex items-center gap-2 text-[13px] text-neutral-800 hover:text-neutral-950 hover:underline"
                        download
                      >
                        <FileText className="w-3.5 h-3.5 text-neutral-500" />
                        <span className="flex-1 truncate">{a.filename}</span>
                        {a.size != null && (
                          <span className="text-[11px] font-mono text-neutral-400">
                            {(a.size / 1024).toFixed(1)} KB
                          </span>
                        )}
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {summary.output && (
                <div>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
                    {t('tasks.finalOutputHeader') || '최종 결과'}
                  </div>
                  <div className="rounded bg-neutral-50 border border-neutral-200 text-[13px] text-neutral-800 px-3 py-2 whitespace-pre-wrap leading-relaxed max-h-[320px] overflow-y-auto">
                    {summary.output}
                  </div>
                </div>
              )}
              {summary.transcript.length > 0 && (
                <div>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
                    {t('tasks.runTraceHeader') || '수행 과정'}
                  </div>
                  <ol className="rounded bg-neutral-50 border border-neutral-200 text-[12px] text-neutral-700 px-3 py-2 space-y-1 max-h-[320px] overflow-y-auto font-mono">
                    {summary.transcript.map((e, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-neutral-400 shrink-0">{i + 1}.</span>
                        <span className="flex-1">{renderTranscriptEntry(e, team)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-200 flex items-center gap-2 bg-white rounded-b-md">
          {pendingAsk && (
            <Button size="sm" variant="primary" onClick={() => setShowAsk(true)}>
              <Question className="w-3.5 h-3.5" />
              {t('tasks.answer')} ({pendingAsk.questions.length})
            </Button>
          )}
          {team && latest?.status !== 'running' && (
            <Button
              size="sm"
              variant={latest ? 'outline' : 'primary'}
              onClick={() => {
                void startSessionFromTask(task, team)
              }}
            >
              <Play weight="fill" className="w-3.5 h-3.5" />
              {t('tasks.runNow')}
            </Button>
          )}
          {latest?.status === 'running' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => stopSession(latest.id)}
            >
              <Stop className="w-3.5 h-3.5" />
              {t('tasks.stop')}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const id = task.id
                onClose()
                removeTask(id)
              }}
              className="text-neutral-500 hover:text-red-600"
            >
              <Trash className="w-3.5 h-3.5" />
              {t('tasks.delete')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('tasks.close')}
            </Button>
          </div>
        </div>
      </div>

      <AskUserModal
        open={showAsk}
        questions={(pendingAsk?.questions as AskUserQuestion[]) ?? []}
        agentRole={pendingAsk?.agentRole}
        onSubmit={submitAnswers}
        onSkip={skipAsk}
      />
    </div>
  )
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}
