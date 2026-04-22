import { Clock, FileText, FilePlus, Lightning, Play, X } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useRef, useState } from 'react'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import type { TaskReference } from '@/lib/types'
import { Button } from '../ui/Button'
import { readAsReference } from './referenceUpload'

export type CreateMode = 'draft' | 'session' | 'scheduled'

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

const CRON_PRESETS: { key: string; value: string }[] = [
  { key: 'tasks.cronPreset.hourly', value: '0 * * * *' },
  { key: 'tasks.cronPreset.daily9', value: '0 9 * * *' },
  { key: 'tasks.cronPreset.weekly9', value: '0 9 * * MON' },
  { key: 'tasks.cronPreset.monthly9', value: '0 9 1 * *' },
]

export function NewTaskModal({ open, onClose, onSubmit }: NewTaskModalProps) {
  const t = useT()
  const [mode, setMode] = useState<CreateMode>('draft')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [cron, setCron] = useState('0 9 * * *')
  const [references, setReferences] = useState<TaskReference[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEscapeClose(open, onClose)

  if (!open) return null

  const reset = () => {
    setTitle('')
    setPrompt('')
    setMode('draft')
    setCron('0 9 * * *')
    setReferences([])
  }

  const submit = () => {
    if (!prompt.trim()) return
    const derivedTitle = title.trim() || prompt.trim().slice(0, 40)
    onSubmit({
      title: derivedTitle,
      prompt: prompt.trim(),
      mode,
      cron: mode === 'scheduled' ? cron.trim() : undefined,
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

  const submitLabel =
    mode === 'draft' ? t('tasks.submit.draft')
      : mode === 'session' ? t('tasks.submit.session')
      : t('tasks.submit.scheduled')

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[560px] max-w-[94vw] max-h-[90vh] overflow-y-auto rounded-md bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 sticky top-0 bg-white">
          <div className="text-[15px] font-medium">{t('tasks.newTitle')}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('tasks.close')}
            className="p-1 rounded hover:bg-neutral-100 text-neutral-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="text-[14px] text-neutral-500">{t('tasks.fieldTitle')}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('tasks.titlePlaceholder')}
              className="mt-1 w-full px-2.5 py-1.5 text-[15px] rounded-sm border border-neutral-300 bg-white"
            />
          </div>

          <div>
            <label className="text-[14px] text-neutral-500">{t('tasks.fieldPrompt')}</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('tasks.promptPlaceholder')}
              rows={4}
              className="mt-1 w-full px-2.5 py-1.5 text-[15px] rounded-sm border border-neutral-300 bg-white resize-none"
            />
          </div>

          <div>
            <label className="text-[14px] text-neutral-500">{t('tasks.fieldReferences')}</label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => void handleFiles(e.target.files)}
              className="hidden"
            />
            <div className="mt-1 rounded-sm border border-dashed border-neutral-300 bg-neutral-50 p-2">
              {references.length === 0 ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 py-3 text-[13px] text-neutral-500 hover:text-neutral-800 cursor-pointer"
                >
                  <FilePlus className="w-4 h-4" />
                  {t('tasks.addReference')}
                </button>
              ) : (
                <div className="space-y-1.5">
                  {references.map((ref) => (
                    <div
                      key={ref.id}
                      className="bg-white border border-neutral-200 rounded-sm px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                        <span className="flex-1 text-[13px] truncate">{ref.name}</span>
                        <span className="text-[11px] text-neutral-400 font-mono shrink-0">
                          {formatBytes(ref.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setReferences((r) => r.filter((x) => x.id !== ref.id))}
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
                          setReferences((rs) =>
                            rs.map((x) => (x.id === ref.id ? { ...x, note: e.target.value } : x)),
                          )
                        }
                        placeholder={t('tasks.referenceNotePlaceholder')}
                        className="mt-1 w-full px-2 py-1 text-[12px] rounded-sm border border-neutral-200 bg-neutral-50 focus:bg-white focus:border-neutral-400 focus:outline-none"
                      />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[12px] text-neutral-500 hover:text-neutral-800 cursor-pointer"
                  >
                    <FilePlus className="w-3 h-3" />
                    {t('tasks.addReference')}
                  </button>
                </div>
              )}
            </div>
            <div className="mt-1 text-[12px] text-neutral-400">{t('tasks.referencesHint')}</div>
          </div>

          <div>
            <label className="text-[14px] text-neutral-500">{t('tasks.mode')}</label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              <ModeButton
                active={mode === 'draft'}
                onClick={() => setMode('draft')}
                icon={<FileText className="w-4 h-4" />}
                label={t('tasks.modeDraft')}
              />
              <ModeButton
                active={mode === 'session'}
                onClick={() => setMode('session')}
                icon={<Play weight="fill" className="w-4 h-4" />}
                label={t('tasks.modeRun')}
              />
              <ModeButton
                active={mode === 'scheduled'}
                onClick={() => setMode('scheduled')}
                icon={<Clock className="w-4 h-4" />}
                label={t('tasks.modeScheduled')}
              />
            </div>
            <div className="mt-1.5 text-[12px] text-neutral-500">
              {mode === 'draft' && t('tasks.modeDraftHint')}
              {mode === 'session' && (
                <span className="inline-flex items-center gap-1 text-blue-700">
                  <Lightning className="w-3 h-3" />
                  {t('tasks.modeRunHint')}
                </span>
              )}
              {mode === 'scheduled' && t('tasks.modeScheduledHint')}
            </div>
          </div>

          {mode === 'scheduled' && (
            <div>
              <label className="text-[14px] text-neutral-500">{t('tasks.cron')}</label>
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * *"
                className="mt-1 w-full px-2.5 py-1.5 text-[15px] font-mono rounded-sm border border-neutral-300 bg-white"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setCron(p.value)}
                    className={clsx(
                      'px-2 py-0.5 rounded-sm text-[14px] border',
                      cron === p.value
                        ? 'border-neutral-900 bg-neutral-100 text-neutral-900'
                        : 'border-neutral-300 bg-white text-neutral-500 hover:bg-neutral-50',
                    )}
                  >
                    {t(p.key)}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[13px] text-neutral-400">{t('tasks.cronHint')}</div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-neutral-200 sticky bottom-0 bg-white">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('tasks.cancel')}
          </Button>
          <Button size="sm" variant="primary" onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ModeButton({
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
        'flex items-center justify-center gap-2 px-3 py-2 rounded-sm border text-[14px] transition-colors',
        active
          ? 'border-neutral-900 bg-neutral-900 text-white'
          : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50',
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
