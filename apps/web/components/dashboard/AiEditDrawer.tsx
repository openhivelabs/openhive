import { ArrowUUpLeft, Check, PaperPlaneRight, Sparkle, X } from '@phosphor-icons/react'
import { useState } from 'react'

export interface AiEditDrawerProps {
  open: boolean
  onClose: () => void
  onApply: () => Promise<void> | void
  onRestore: () => Promise<void> | void
}

interface Turn {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Right-side AI editor drawer. Dashboard enters "edit mode" when this opens —
 * a snapshot was captured beforehand, so the user can discard all changes via
 * "복원" (restore from snapshot) or lock them in with "적용" (discard snapshot).
 */
export function AiEditDrawer({ open, onClose, onApply, onRestore }: AiEditDrawerProps) {
  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const send = () => {
    const text = input.trim()
    if (!text) return
    setTurns((prev) => [
      ...prev,
      { role: 'user', text },
      {
        role: 'assistant',
        text:
          '[아직 배선 중] 실제 AI 편집은 다음 단계에서 연결됩니다. 스키마·블록 변경 시도는 지금 스냅샷이 보호 중이에요.',
      },
    ])
    setInput('')
  }

  const apply = async () => {
    setBusy(true)
    try {
      await onApply()
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    setBusy(true)
    try {
      await onRestore()
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="w-[380px] shrink-0 border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col">
      <header className="h-[46px] shrink-0 px-3 flex items-center gap-2 border-b border-neutral-200 dark:border-neutral-800">
        <Sparkle weight="fill" className="w-4 h-4 text-amber-500" />
        <span className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
          커스터마이즈
        </span>
        <span className="text-[14px] text-amber-600 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 px-1.5 py-0.5 rounded-sm">
          스냅샷 보호 중
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="w-6 h-6 flex items-center justify-center rounded-sm text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {turns.length === 0 && (
          <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 p-4 text-center">
            <div className="text-[14px] font-medium text-neutral-700 dark:text-neutral-200">
              이 팀의 대시보드·데이터를 자연어로 수정
            </div>
            <p className="text-[14px] text-neutral-500 mt-1 leading-relaxed">
              예: "pipeline 블록을 월별 매출 차트로 바꿔줘" · "고객 테이블에 region 컬럼 추가해줘"
            </p>
          </div>
        )}
        {turns.map((turn, i) => (
          <div
            key={i}
            className={
              turn.role === 'user'
                ? 'ml-6 rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 p-2 text-[14px] leading-relaxed'
                : 'mr-6 rounded-md bg-neutral-50 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 p-2 text-[14px] leading-relaxed border border-neutral-200 dark:border-neutral-700'
            }
          >
            {turn.text}
          </div>
        ))}
      </div>

      <div className="border-t border-neutral-200 dark:border-neutral-800 p-2 space-y-2">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="무엇을 바꿀까요?"
            rows={2}
            className="flex-1 resize-none rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[14px] text-neutral-800 dark:text-neutral-100 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim() || busy}
            className="h-8 w-8 flex items-center justify-center rounded-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 disabled:opacity-40 cursor-pointer"
            aria-label="Send"
          >
            <PaperPlaneRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={restore}
            disabled={busy}
            className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-[14px] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <ArrowUUpLeft className="w-3.5 h-3.5" />
            스냅샷 복원
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={busy}
            className="h-8 px-3 rounded-sm bg-amber-500 hover:bg-amber-600 text-white text-[14px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            적용
          </button>
        </div>
      </div>
    </aside>
  )
}
