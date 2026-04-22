import { useState } from 'react'
import { CaretDown, CaretUp, PaperPlaneTilt, Sparkle } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useT } from '@/lib/i18n'

export interface ComposerReply {
  assistant_message: string
  applied: {
    kind: 'created' | 'edited' | 'deleted' | 'none'
    panel_id?: string
  }
}

interface Turn {
  role: 'user' | 'assistant'
  text: string
  applied?: ComposerReply['applied']
}

/**
 * Always-visible chat dock on the Dashboard page. User types a natural-language
 * request; server returns a one-shot composer reply and applies the change to
 * dashboard.yaml. We fire `onApplied` so the parent refetches the layout.
 */
export function DashboardAiDock({
  teamId,
  onApplied,
}: {
  teamId: string
  onApplied: (applied: ComposerReply['applied']) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    const msg = input.trim()
    if (!msg || sending || !teamId) return
    setInput('')
    setError(null)
    setSending(true)
    setTurns((s) => [...s, { role: 'user', text: msg }])
    // Auto-open the transcript when the first turn is sent so the user sees
    // the assistant's reply instead of typing into the void.
    setOpen(true)
    try {
      const res = await fetch('/api/composer/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, message: msg }),
      })
      const body = (await res.json().catch(() => ({}))) as Partial<ComposerReply> & {
        detail?: string
      }
      if (!res.ok) {
        throw new Error(body.detail ?? `HTTP ${res.status}`)
      }
      setTurns((s) => [
        ...s,
        {
          role: 'assistant',
          text: body.assistant_message ?? '',
          applied: body.applied,
        },
      ])
      if (body.applied && body.applied.kind !== 'none') {
        onApplied(body.applied)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setTurns((s) => [...s, { role: 'assistant', text: `⚠ ${msg}` }])
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 pointer-events-none flex justify-center px-4 pb-4">
      <div
        className={clsx(
          'pointer-events-auto w-full max-w-[760px] rounded-lg shadow-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 transition-all',
          open ? 'max-h-[420px]' : 'max-h-[68px]',
        )}
      >
        {open && turns.length > 0 && (
          <div className="max-h-[280px] overflow-y-auto px-4 py-3 space-y-2 border-b border-neutral-100 dark:border-neutral-800">
            {turns.map((turn, i) => (
              <TurnBubble key={i} turn={turn} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 p-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? t('dock.collapse') : t('dock.expand')}
            className="w-8 h-8 flex items-center justify-center rounded-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer shrink-0"
          >
            {open ? <CaretDown className="w-4 h-4" /> : <CaretUp className="w-4 h-4" />}
          </button>
          <Sparkle className="w-4 h-4 text-amber-500 mb-2 shrink-0" />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('dock.placeholder')}
            rows={1}
            disabled={sending}
            className="flex-1 resize-none px-2 py-1.5 rounded-sm text-[14px] bg-transparent text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none max-h-[120px]"
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim() || sending}
            aria-label={t('dock.send')}
            className={clsx(
              'w-8 h-8 flex items-center justify-center rounded-sm cursor-pointer shrink-0',
              input.trim() && !sending
                ? 'bg-amber-500 hover:bg-amber-600 text-white'
                : 'bg-neutral-200 dark:bg-neutral-800 text-neutral-400',
            )}
          >
            <PaperPlaneTilt className="w-4 h-4" />
          </button>
        </div>
        {error && open && (
          <div className="px-4 pb-3 text-[12px] text-red-600 dark:text-red-400">{error}</div>
        )}
      </div>
    </div>
  )
}

function TurnBubble({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-1.5 rounded-sm bg-amber-500 text-white text-[13px] whitespace-pre-wrap">
          {turn.text}
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-3 py-1.5 rounded-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 text-[13px] whitespace-pre-wrap">
        {turn.text}
        {turn.applied && turn.applied.kind !== 'none' && (
          <span className="ml-2 text-[11px] text-neutral-500 font-mono">
            [{turn.applied.kind}
            {turn.applied.panel_id ? ` · ${turn.applied.panel_id}` : ''}]
          </span>
        )}
      </div>
    </div>
  )
}
