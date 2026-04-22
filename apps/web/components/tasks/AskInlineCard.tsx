import { CaretLeft, CaretRight, PencilSimple } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { useT } from '@/lib/i18n'
import type { AskUserQuestion } from '@/lib/api/sessions'

interface Props {
  questions: AskUserQuestion[]
  agentRole?: string
  onSubmit: (answers: Record<string, string>) => Promise<void> | void
  onSkip: () => Promise<void> | void
  /** While a submit/skip request is inflight. Disables buttons. */
  busy?: boolean
}

type Answer = { kind: 'option'; label: string } | { kind: 'other'; text: string }

/** Inline replacement for AskUserModal — renders as a chat bubble instead of
 *  an overlay. One question at a time when multiple (same semantics as the
 *  original modal), but embedded in the conversation flow so answering feels
 *  like a natural reply, not a blocking popup. */
export function AskInlineCard({
  questions,
  agentRole,
  onSubmit,
  onSkip,
  busy,
}: Props) {
  const t = useT()
  const [page, setPage] = useState(0)
  const [answers, setAnswers] = useState<Record<number, Answer>>({})
  const [otherDraft, setOtherDraft] = useState<Record<number, string>>({})

  const total = questions.length
  const q = questions[page]
  if (!q) return null

  const canGoPrev = page > 0
  const canGoNext = useMemo(() => {
    const a = answers[page]
    if (!a) return false
    if (a.kind === 'option') return true
    return a.text.trim().length > 0
  }, [answers, page])

  const pick = (optionLabel: string) => {
    setAnswers({ ...answers, [page]: { kind: 'option', label: optionLabel } })
  }
  const pickOther = () => {
    const text = otherDraft[page] ?? ''
    setAnswers({ ...answers, [page]: { kind: 'other', text } })
  }
  const finalize = () => {
    const out: Record<string, string> = {}
    questions.forEach((qn, i) => {
      const a = answers[i]
      if (!a) return
      out[qn.question] = a.kind === 'option' ? a.label : a.text
    })
    void onSubmit(out)
  }
  const goNext = () => {
    if (page === total - 1) finalize()
    else setPage(page + 1)
  }

  const currentAnswer = answers[page]
  const otherSelected = currentAnswer?.kind === 'other'

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-b border-neutral-200 dark:border-neutral-800">
          <span className="min-w-0 text-[13.5px] text-neutral-900 dark:text-neutral-100 truncate">
            {q.question}
          </span>
          {total > 1 && (
            <div className="shrink-0 flex items-center gap-1 text-[11px] text-neutral-500">
              <button
                type="button"
                onClick={() => canGoPrev && setPage(page - 1)}
                disabled={!canGoPrev}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <CaretLeft className="w-3 h-3" />
              </button>
              <span className="font-mono">
                {page + 1}/{total}
              </span>
              <button
                type="button"
                onClick={() => canGoNext && goNext()}
                disabled={!canGoNext}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <CaretRight className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Options */}
        <div className="p-2 space-y-1">
          {q.options.map((opt, idx) => {
            const isActive =
              currentAnswer?.kind === 'option' && currentAnswer.label === opt.label
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => pick(opt.label)}
                className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded text-left transition-colors ${
                  isActive
                    ? 'bg-neutral-100 dark:bg-neutral-800'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                }`}
              >
                <span className="mt-0.5 w-5 h-5 shrink-0 rounded-sm bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 text-[11px] font-mono flex items-center justify-center text-neutral-500 dark:text-neutral-400">
                  {idx + 1}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] text-neutral-900 dark:text-neutral-100">
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="block text-[12px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {opt.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}

          <div
            className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded ${
              otherSelected ? 'bg-neutral-100 dark:bg-neutral-800' : ''
            }`}
          >
            <PencilSimple className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400 shrink-0" />
            <input
              value={otherDraft[page] ?? ''}
              onChange={(e) => {
                setOtherDraft({ ...otherDraft, [page]: e.target.value })
                if (e.target.value.trim()) {
                  setAnswers({
                    ...answers,
                    [page]: { kind: 'other', text: e.target.value },
                  })
                } else if (otherSelected) {
                  const next = { ...answers }
                  delete next[page]
                  setAnswers(next)
                }
              }}
              onFocus={pickOther}
              placeholder={t('session.askOtherPlaceholder')}
              className="flex-1 bg-transparent text-[13px] text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-600 outline-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/40 rounded-b-md">
          <button
            type="button"
            onClick={() => void onSkip()}
            disabled={busy}
            className="px-2.5 py-1 text-[12.5px] rounded-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('session.askSkip')}
          </button>
          <button
            type="button"
            disabled={!canGoNext || busy}
            onClick={goNext}
            className="px-3 py-1 text-[12.5px] font-medium rounded-sm bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {page === total - 1 ? t('session.askSubmit') : t('session.askNext')}
          </button>
        </div>
    </div>
  )
}
