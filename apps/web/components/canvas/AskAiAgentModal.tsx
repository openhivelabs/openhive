import { CircleNotch, X } from '@phosphor-icons/react'
import { useState } from 'react'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import type { Agent } from '@/lib/types'
import { Button } from '../ui/Button'

interface AskAiAgentModalProps {
  open: boolean
  onClose: () => void
  onCreate: (agent: Agent, warnings?: string[]) => void
  companySlug: string
}

export function AskAiAgentModal({ open, onClose, onCreate, companySlug }: AskAiAgentModalProps) {
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
        body: JSON.stringify({ description, company_slug: companySlug || undefined }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`generate failed (${res.status}): ${body}`)
      }
      const raw = (await res.json()) as Record<string, unknown>
      const personaPath =
        typeof raw.persona_path === 'string' && raw.persona_path ? raw.persona_path : undefined
      const personaName =
        typeof raw.persona_name === 'string' && raw.persona_name ? raw.persona_name : undefined
      const agent: Agent = {
        id: String(raw.id ?? ''),
        role: String(raw.role ?? 'Member'),
        label: String(raw.label ?? 'Copilot'),
        providerId: String(raw.provider_id ?? 'copilot'),
        model: String(raw.model ?? 'gpt-5-mini'),
        systemPrompt: String(raw.system_prompt ?? ''),
        skills: (raw.skills as string[]) ?? [],
        position: (raw.position as { x: number; y: number }) ?? { x: 0, y: 0 },
        personaPath,
        personaName,
      }
      const warnings = Array.isArray(raw.warnings) ? (raw.warnings as string[]) : undefined
      onCreate(agent, warnings)
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
            disabled={loading}
            // biome-ignore lint/a11y/noAutofocus: the modal is intent-driven — typing is the only thing to do
            autoFocus
          />
          {error && (
            <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5 whitespace-pre-wrap">
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
