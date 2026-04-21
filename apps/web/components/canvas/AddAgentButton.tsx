'use client'

import { Plus, Sparkle, User } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'

export function AddAgentButton({
  onAddManual,
  onAddViaAi,
}: {
  onAddManual: () => void
  onAddViaAi: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="absolute top-4 left-4 z-10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-9 px-3 rounded-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-[14px] font-medium flex items-center gap-1.5 hover:opacity-90 cursor-pointer shadow-sm"
      >
        <Plus className="w-4 h-4" />
        {t('canvas.addAgent')}
      </button>
      {open && (
        <div className="mt-2 w-[320px] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg p-1.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onAddViaAi()
            }}
            className="w-full flex items-start gap-2.5 p-2.5 rounded-sm hover:bg-amber-50 dark:hover:bg-amber-950/30 text-left cursor-pointer"
          >
            <Sparkle weight="fill" className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-neutral-800 dark:text-neutral-100">
                {t('canvas.addViaAi')}
              </div>
              <div className="text-[12px] text-neutral-500 leading-relaxed mt-0.5">
                {t('canvas.addViaAiHint')}
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onAddManual()
            }}
            className="w-full flex items-start gap-2.5 p-2.5 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 text-left cursor-pointer"
          >
            <User className="w-4 h-4 mt-0.5 text-neutral-500 shrink-0" />
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-neutral-800 dark:text-neutral-100">
                {t('canvas.addManual')}
              </div>
              <div className="text-[12px] text-neutral-500 leading-relaxed mt-0.5">
                {t('canvas.addManualHint')}
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
