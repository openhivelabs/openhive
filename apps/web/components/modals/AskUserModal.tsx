import { CaretLeft, CaretRight, PencilSimple, X } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import type { AskUserQuestion } from '@/lib/api/sessions'

interface AskUserModalProps {
  open: boolean
  questions: AskUserQuestion[]
  agentRole?: string
  onSubmit: (answers: Record<string, string>) => void
  onSkip: () => void
}

type Answer = { kind: 'option'; label: string } | { kind: 'other'; text: string }

export function AskUserModal({ open, questions, agentRole, onSubmit, onSkip }: AskUserModalProps) {
  const t = useT()
  const [page, setPage] = useState(0)
  const [answers, setAnswers] = useState<Record<number, Answer>>({})
  const [otherDraft, setOtherDraft] = useState<Record<number, string>>({})

  const total = questions.length
  const q = questions[page]

  const canGoPrev = page > 0
  const canGoNext = useMemo(() => {
    const a = answers[page]
    if (!a) return false
    if (a.kind === 'option') return true
    return a.text.trim().length > 0
  }, [answers, page])

  useEscapeClose(open, onSkip)

  if (!open || !q) return null

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
    onSubmit(out)
  }

  const goNext = () => {
    if (page === total - 1) {
      finalize()
    } else {
      setPage(page + 1)
    }
  }

  const currentAnswer = answers[page]
  const otherSelected = currentAnswer?.kind === 'other'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-2xl rounded-md bg-neutral-900 text-neutral-100 shadow-2xl border border-neutral-800">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div className="flex items-center gap-2 text-[15px] text-neutral-300">
            {agentRole && (
              <span className="px-2 py-0.5 rounded-sm bg-neutral-800 text-[14px] text-neutral-400">
                {agentRole}
              </span>
            )}
            <span className="font-medium">{q.question}</span>
          </div>
          <div className="flex items-center gap-3">
            {total > 1 && (
              <div className="flex items-center gap-1 text-[15px] text-neutral-500">
                <button
                  type="button"
                  onClick={() => canGoPrev && setPage(page - 1)}
                  disabled={!canGoPrev}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <CaretLeft className="w-3.5 h-3.5" />
                </button>
                <span className="font-mono">
                  {t('askUser.pageOf', { current: page + 1, total })}
                </span>
                <button
                  type="button"
                  onClick={() => canGoNext && goNext()}
                  disabled={!canGoNext}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <CaretRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={onSkip}
              aria-label={t('settings.close')}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-neutral-800 text-neutral-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-3 pb-3">
          {q.options.map((opt, idx) => {
            const isActive = currentAnswer?.kind === 'option' && currentAnswer.label === opt.label
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => pick(opt.label)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded text-left transition-colors ${
                  isActive ? 'bg-neutral-700' : 'hover:bg-neutral-800'
                }`}
              >
                <span className="w-6 h-6 rounded-sm bg-neutral-800 text-[15px] flex items-center justify-center text-neutral-400">
                  {idx + 1}
                </span>
                <span className="flex-1">
                  <span className="block text-[15px]">{opt.label}</span>
                  {opt.description && (
                    <span className="block text-[14px] text-neutral-500 mt-0.5">{opt.description}</span>
                  )}
                </span>
                {isActive && <CaretRight className="w-4 h-4 text-neutral-400" />}
              </button>
            )
          })}

          <div
            className={`flex items-center gap-3 px-4 py-3 rounded ${
              otherSelected ? 'bg-neutral-800' : ''
            }`}
          >
            <PencilSimple className="w-4 h-4 text-neutral-500" />
            <input
              value={otherDraft[page] ?? ''}
              onChange={(e) => {
                setOtherDraft({ ...otherDraft, [page]: e.target.value })
                if (e.target.value.trim()) {
                  setAnswers({ ...answers, [page]: { kind: 'other', text: e.target.value } })
                } else if (otherSelected) {
                  const next = { ...answers }
                  delete next[page]
                  setAnswers(next)
                }
              }}
              onFocus={pickOther}
              placeholder={t('askUser.otherPlaceholder')}
              className="flex-1 bg-transparent text-[15px] text-neutral-200 placeholder-neutral-600 outline-none"
            />
            <button
              type="button"
              onClick={onSkip}
              className="px-3 py-1 text-[15px] rounded-sm border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            >
              {t('askUser.skip')}
            </button>
          </div>
        </div>

        <div className="px-6 py-3 border-t border-neutral-800 flex items-center justify-between text-[14px] text-neutral-500">
          <div>{t('askUser.navigationHint')}</div>
          <button
            type="button"
            disabled={!canGoNext}
            onClick={goNext}
            className="px-4 py-1.5 rounded-sm bg-neutral-100 text-neutral-900 text-[15px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {page === total - 1 ? t('askUser.submit') : t('askUser.next')}
          </button>
        </div>
      </div>
    </div>
  )
}
