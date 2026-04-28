import { Clock, FileText, FilePlus, X } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useRef, useState } from 'react'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import type { TaskReference } from '@/lib/types'
import { readAsReference } from './referenceUpload'

type CreateMode = 'draft' | 'scheduled'

export interface CreateTaskInput {
  title: string
  prompt: string
  mode: CreateMode
  cron?: string
  references: TaskReference[]
}

interface NewTaskModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (input: CreateTaskInput) => void
}

type Freq = 'hourly' | 'daily' | 'weekly'

const DOW_KEYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const

function buildCron(s: {
  freq: Freq
  minute: number
  hour: number
  dows: Set<(typeof DOW_KEYS)[number]>
}): string {
  const m = String(s.minute)
  const h = String(s.hour)
  if (s.freq === 'hourly') return `${m} * * * *`
  if (s.freq === 'daily') return `${m} ${h} * * *`
  // Weekly — comma-separated list preserving weekday order. Fall back to MON
  // if the user somehow unselected everything.
  const picked = DOW_KEYS.filter((d) => s.dows.has(d))
  const list = picked.length > 0 ? picked.join(',') : 'MON'
  return `${m} ${h} * * ${list}`
}

export function NewTaskModal({ open, onClose, onSubmit }: NewTaskModalProps) {
  const t = useT()
  const [mode, setMode] = useState<CreateMode>('draft')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [freq, setFreq] = useState<Freq>('daily')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [dows, setDows] = useState<Set<(typeof DOW_KEYS)[number]>>(
    () => new Set(['MON']),
  )
  const [references, setReferences] = useState<TaskReference[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEscapeClose(open, onClose)

  if (!open) return null

  const reset = () => {
    setTitle('')
    setPrompt('')
    setMode('draft')
    setFreq('daily')
    setHour(9)
    setMinute(0)
    setDows(new Set(['MON']))
    setReferences([])
  }

  const submit = () => {
    if (!prompt.trim()) return
    const derivedTitle = title.trim() || prompt.trim().slice(0, 40)
    const cron = buildCron({ freq, minute, hour, dows })
    onSubmit({
      title: derivedTitle,
      prompt: prompt.trim(),
      mode,
      cron: mode === 'scheduled' ? cron : undefined,
      references,
    })
    reset()
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    const picked: TaskReference[] = []
    for (const f of Array.from(files)) {
      picked.push(await readAsReference(f))
    }
    setReferences((prev) => [...prev, ...picked])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const submitLabel = t('tasks.submit.draft')

  const canSubmit = prompt.trim().length > 0

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[620px] max-w-[94vw] max-h-[90vh] overflow-hidden rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200 dark:border-neutral-800 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 dark:border-neutral-800">
          <div className="text-[17px] font-semibold text-neutral-900 dark:text-neutral-100 tracking-tight">
            {t('tasks.newTitle')}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('tasks.close')}
            className="w-8 h-8 flex items-center justify-center rounded-md text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto scrollbar-quiet px-6 py-5 space-y-5">
          <Field label={t('tasks.fieldTitle')}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('tasks.titlePlaceholder')}
              className="w-full px-3 py-2 text-[14px] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-400 dark:focus:border-neutral-500 transition-colors"
            />
          </Field>

          <Field label={t('tasks.fieldPrompt')}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('tasks.promptPlaceholder')}
              rows={5}
              className="w-full px-3 py-2 text-[14px] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 resize-none focus:outline-none focus:border-neutral-400 dark:focus:border-neutral-500 transition-colors leading-relaxed"
            />
          </Field>

          <Field label={t('tasks.fieldReferences')}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => void handleFiles(e.target.files)}
              className="hidden"
            />
            {references.length === 0 ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-4 text-[13px] text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 border border-dashed border-neutral-300 dark:border-neutral-700 rounded-md hover:border-neutral-400 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors cursor-pointer"
              >
                <FilePlus className="w-4 h-4" />
                {t('tasks.addReference')}
              </button>
            ) : (
              <div className="space-y-2">
                {references.map((ref) => (
                  <div
                    key={ref.id}
                    className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-800/30 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-neutral-400 shrink-0" />
                      <span className="flex-1 text-[13px] text-neutral-900 dark:text-neutral-100 truncate">
                        {ref.name}
                      </span>
                      <span className="text-[11px] text-neutral-400 font-mono shrink-0 tabular-nums">
                        {formatBytes(ref.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setReferences((r) => r.filter((x) => x.id !== ref.id))}
                        aria-label={t('tasks.removeReference')}
                        className="w-5 h-5 flex items-center justify-center rounded text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={ref.note ?? ''}
                      onChange={(e) =>
                        setReferences((rs) =>
                          rs.map((x) => (x.id === ref.id ? { ...x, note: e.target.value } : x)),
                        )
                      }
                      placeholder={t('tasks.referenceNotePlaceholder')}
                      className="mt-2 w-full px-2 py-1 text-[12px] rounded border border-transparent bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-300 dark:focus:border-neutral-600 transition-colors"
                    />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[12px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
                >
                  <FilePlus className="w-3 h-3" />
                  {t('tasks.addReference')}
                </button>
              </div>
            )}
          </Field>

          <Field label={t('tasks.mode')}>
            <div className="inline-flex p-0.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100/60 dark:bg-neutral-800/40">
              <SegButton
                active={mode === 'draft'}
                onClick={() => setMode('draft')}
                icon={<FileText className="w-3.5 h-3.5" />}
                label={t('tasks.modeDraft')}
              />
              <SegButton
                active={mode === 'scheduled'}
                onClick={() => setMode('scheduled')}
                icon={<Clock className="w-3.5 h-3.5" />}
                label={t('tasks.modeScheduled')}
              />
            </div>
          </Field>

          {mode === 'scheduled' && (
            <Field label={t('tasks.schedule.label')}>
              <div className="space-y-3">
                {/* Frequency segmented control */}
                <div className="inline-flex p-0.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100/60 dark:bg-neutral-800/40">
                  {(['hourly', 'daily', 'weekly'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFreq(f)}
                      className={clsx(
                        'px-3 py-1.5 rounded-md text-[13px] font-medium transition-all',
                        freq === f
                          ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-sm'
                          : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100',
                      )}
                    >
                      {t(`tasks.schedule.freq.${f}`)}
                    </button>
                  ))}
                </div>

                {/* Day-of-week multi-picker (weekly) */}
                {freq === 'weekly' && (
                  <div className="flex gap-1">
                    {DOW_KEYS.map((d) => {
                      const active = dows.has(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() =>
                            setDows((prev) => {
                              const next = new Set(prev)
                              if (next.has(d)) {
                                if (next.size > 1) next.delete(d)
                              } else {
                                next.add(d)
                              }
                              return next
                            })
                          }
                          className={clsx(
                            'w-9 h-9 rounded-md text-[12px] font-medium border transition-colors',
                            active
                              ? 'border-neutral-900 dark:border-neutral-100 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900'
                              : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300 hover:border-neutral-400 dark:hover:border-neutral-500',
                          )}
                        >
                          {t(`tasks.schedule.dow.${d}`)}
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Time picker */}
                <div className="flex items-center gap-2 text-[13px] text-neutral-600 dark:text-neutral-300">
                  <span>{t(freq === 'hourly' ? 'tasks.schedule.atMinute' : 'tasks.schedule.atTime')}</span>
                  {freq !== 'hourly' && (
                    <>
                      <select
                        value={hour}
                        onChange={(e) => setHour(Number(e.target.value))}
                        className="px-2 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-neutral-400 dark:focus:border-neutral-500 tabular-nums font-mono"
                      >
                        {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                          <option key={h} value={h}>
                            {String(h).padStart(2, '0')}
                          </option>
                        ))}
                      </select>
                      <span className="font-mono text-neutral-400">:</span>
                    </>
                  )}
                  <select
                    value={minute}
                    onChange={(e) => setMinute(Number(e.target.value))}
                    className="px-2 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-neutral-400 dark:focus:border-neutral-500 tabular-nums font-mono"
                  >
                    {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                      <option key={m} value={m}>
                        {String(m).padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </Field>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end items-center gap-2 px-6 py-4 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/60">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-[13px] rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            {t('tasks.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-[13px] font-medium rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11.5px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1.5">
        {label}
      </label>
      {children}
      {hint && (
        <div className="mt-1.5 text-[11.5px] text-neutral-400 dark:text-neutral-500">
          {hint}
        </div>
      )}
    </div>
  )
}

function SegButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-all',
        active
          ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-sm'
          : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}
