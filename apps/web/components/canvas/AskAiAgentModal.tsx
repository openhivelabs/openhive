import { X } from '@phosphor-icons/react'
import { useState } from 'react'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import { Button } from '../ui/Button'

interface AskAiAgentModalProps {
  open: boolean
  onClose: () => void
  /** Fire-and-forget: parent kicks off generation and renders progress UI
   *  outside this modal so the user isn't stuck watching a spinner. */
  onSubmit: (description: string) => void
}

export function AskAiAgentModal({ open, onClose, onSubmit }: AskAiAgentModalProps) {
  const t = useT()
  const defaultModel = useAppStore((s) => s.defaultModel)
  const [description, setDescription] = useState('')

  useEscapeClose(open, onClose)

  if (!open) return null

  const reset = () => {
    setDescription('')
    onClose()
  }

  const submit = () => {
    const trimmed = description.trim()
    if (!trimmed || !defaultModel) return
    onSubmit(trimmed)
    reset()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas.askAiTitle')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={reset}
      onKeyDown={(e) => e.key === 'Escape' && reset()}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-md bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200">
          <h2 className="text-[13px] font-semibold text-neutral-800">
            {t('canvas.askAiTitle')}
          </h2>
          <button
            type="button"
            onClick={reset}
            aria-label={t('canvas.close')}
            className="p-1 rounded-sm hover:bg-neutral-100 -mr-1"
          >
            <X className="w-3.5 h-3.5 text-neutral-500" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder={t('canvas.askAiPlaceholder')}
            className="w-full px-3 py-2 text-[13px] rounded border border-neutral-200 focus:outline-none focus:border-neutral-400 focus:ring-2 focus:ring-neutral-100 resize-none"
            // biome-ignore lint/a11y/noAutofocus: the modal is intent-driven — typing is the only thing to do
            autoFocus
          />
          {!defaultModel && (
            <div className="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
              {t('canvas.askAiDefaultModelRequired')}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={reset}>
              {t('canvas.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={!description.trim() || !defaultModel}
            >
              {t('canvas.askAiSubmit')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
