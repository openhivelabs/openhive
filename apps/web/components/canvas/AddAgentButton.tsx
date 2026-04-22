'use client'

import { Package, Plus, Sparkle, User } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'

export function AddAgentButton({
  onAddManual,
  onAddViaAi,
  onAddFromFrame,
}: {
  onAddManual: () => void
  onAddViaAi: () => void
  onAddFromFrame: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      {/* Full-screen scrim catches any click outside the menu and closes it.
          ReactFlow's pane eats pointerdown events, so a window-level listener
          isn't reliable — an explicit overlay wins every time. */}
      {open && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setOpen(false)}
          onPointerDown={() => setOpen(false)}
          className="fixed inset-0 z-10 cursor-default bg-transparent"
        />
      )}
      <div className="absolute top-4 left-4 z-20 w-max">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="h-9 px-3 rounded-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-[14px] font-medium flex items-center gap-1.5 hover:opacity-90 cursor-pointer shadow-sm"
        >
          <Plus className="w-4 h-4" />
          {t('canvas.addAgent')}
        </button>
        {open && (
          <div
            className="absolute left-0 top-full mt-2 w-[320px] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg p-1.5"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onAddViaAi()
              }}
              className="w-full flex items-start gap-2.5 p-2.5 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 text-left cursor-pointer"
            >
              <Sparkle className="w-4 h-4 mt-0.5 text-neutral-500 shrink-0" />
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
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onAddFromFrame()
              }}
              className="w-full flex items-start gap-2.5 p-2.5 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 text-left cursor-pointer"
            >
              <Package className="w-4 h-4 mt-0.5 text-neutral-500 shrink-0" />
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-neutral-800 dark:text-neutral-100">
                  {t('canvas.addFromFrame')}
                </div>
                <div className="text-[12px] text-neutral-500 leading-relaxed mt-0.5">
                  {t('canvas.addFromFrameHint')}
                </div>
              </div>
            </button>
          </div>
        )}
      </div>
    </>
  )
}
