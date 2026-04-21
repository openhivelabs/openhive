'use client'

import {
  FilePlus,
  FileText,
  Lightning,
  PencilSimple,
  Question,
  Stop,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { AskUserModal } from '@/components/modals/AskUserModal'
import { readAsReference } from '@/components/modals/referenceUpload'
import { type AskUserQuestion, postAnswer } from '@/lib/api/runs'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { useCurrentTeam } from '@/lib/stores/useAppStore'
import { taskStatus, useTasksStore } from '@/lib/stores/useTasksStore'
import type { Task, TaskReference } from '@/lib/types'
import { Button } from '../ui/Button'
import { formatDuration, runElapsedMs, useTicker } from './shared'

interface TaskDetailModalProps {
  task: Task | null
  onClose: () => void
}

export function TaskDetailModal({ task, onClose }: TaskDetailModalProps) {
  const t = useT()
  const team = useCurrentTeam()
  const runTaskNow = useTasksStore((s) => s.runTaskNow)
  const stopRun = useTasksStore((s) => s.stopRun)
  const updateRun = useTasksStore((s) => s.updateRun)
  const updateTask = useTasksStore((s) => s.updateTask)
  const [showAsk, setShowAsk] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEscapeClose(task, onClose)

  const status = task ? taskStatus(task) : 'idle'
  // Prefer an "active" run (pending ask, then running, then needs_input) over
  // the array-last run — concurrent runs can leave a short-lived cancel/done
  // at the end of the list that masks a still-active older run.
  const latest = task
    ? task.runs.find((r) => r.status === 'running' && r.pendingAsk) ??
      task.runs.find((r) => r.status === 'running') ??
      task.runs.find((r) => r.status === 'needs_input') ??
      task.runs[task.runs.length - 1]
    : undefined
  const pendingAsk = latest?.pendingAsk

  // Auto-surface the answer UI as soon as a pending question arrives — the
  // whole point of "답변 대기" is that the user reacts. Requiring them to
  // click "답변" first just hides the question and feels broken.
  useEffect(() => {
    if (pendingAsk) setShowAsk(true)
  }, [pendingAsk?.toolCallId])
  const isRunning = status === 'running' || status === 'needs_input'
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
              <span>{t(`tasks.status.${statusKey(status)}`)}</span>
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

          {/* Failure reason only — step-by-step trace lives in the drawer.
              Done tasks show deliverables via the Artifacts tab, not here. */}
          {latest?.status === 'failed' && latest.error && (
            <div className="px-4 py-3">
              <div className="rounded bg-red-50 border border-red-200 text-red-700 text-[14px] px-2.5 py-2">
                <Warning className="inline w-3.5 h-3.5 mr-1" />
                {latest.error}
              </div>
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
          {team && status !== 'running' && (
            <Button
              size="sm"
              variant={latest ? 'outline' : 'primary'}
              onClick={() => {
                void runTaskNow(task, team)
              }}
            >
              <Lightning className="w-3.5 h-3.5" />
              {latest ? t('tasks.runAgain') : t('tasks.runNow')}
            </Button>
          )}
          {status === 'running' && latest && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => stopRun(latest.id)}
            >
              <Stop className="w-3.5 h-3.5" />
              {t('tasks.stop')}
            </Button>
          )}
          <div className="ml-auto">
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

function statusKey(s: string): string {
  if (s === 'needs_input') return 'needsInput'
  return s
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}
