'use client'

import { CircleNotch, Sparkle, X } from '@phosphor-icons/react'
import { useState } from 'react'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import type { Agent } from '@/lib/types'
import { Button } from '../ui/Button'

interface AskAiAgentModalProps {
  open: boolean
  onClose: () => void
  onCreate: (agent: Agent) => void
}

export function AskAiAgentModal({ open, onClose, onCreate }: AskAiAgentModalProps) {
  const t = useT()
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEscapeClose(open, onClose)

  if (!open) return null

  const reset = () => {
    setDescription('')
    setError(null)
    setLoading(false)
    onClose()
  }

  const submit = async () => {
    if (!description.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/agents/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`generate failed (${res.status}): ${body}`)
      }
      const raw = (await res.json()) as Record<string, unknown>
      const agent: Agent = {
        id: String(raw.id ?? ''),
        role: String(raw.role ?? 'Member'),
        label: String(raw.label ?? 'Copilot'),
        providerId: String(raw.provider_id ?? 'copilot'),
        model: String(raw.model ?? 'gpt-5-mini'),
        systemPrompt: String(raw.system_prompt ?? ''),
        skills: (raw.skills as string[]) ?? [],
        position: (raw.position as { x: number; y: number }) ?? { x: 0, y: 0 },
      }
      onCreate(agent)
      reset()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
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
        className="w-[560px] max-w-[94vw] rounded-md bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold flex items-center gap-1.5">
            <Sparkle weight="fill" className="w-4 h-4 text-amber-500" />
            {t('canvas.askAiTitle')}
          </h2>
          <button
            type="button"
            onClick={reset}
            aria-label={t('canvas.close')}
            className="p-1 rounded-sm hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-start gap-2 text-[14px] text-neutral-600 bg-amber-50 border border-amber-200 rounded p-2.5">
            <Sparkle className="w-3.5 h-3.5 mt-0.5 text-amber-600 shrink-0" />
            <div>{t('canvas.askAiBanner')}</div>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder={t('canvas.askAiPlaceholder')}
            className="w-full px-3 py-2 text-[15px] rounded border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
            disabled={loading}
          />
          {error && (
            <div className="text-[14px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2 whitespace-pre-wrap">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={reset}>
              {t('canvas.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={loading || !description.trim()}
            >
              {loading && <CircleNotch className="w-3.5 h-3.5 animate-spin" />}
              {loading ? t('canvas.askAiGenerating') : t('canvas.askAiSubmit')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
