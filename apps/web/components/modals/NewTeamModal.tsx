'use client'

import { Loader2, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '@/lib/stores/useAppStore'
import { PRESETS, type PresetDef, buildTeamFromNaturalLanguage } from '@/lib/presets'
import { Button } from '../ui/Button'

interface NewTeamModalProps {
  open: boolean
  companyId: string | null
  onClose: () => void
}

type Mode = 'picker' | 'nl'

export function NewTeamModal({ open, companyId, onClose }: NewTeamModalProps) {
  const addTeam = useAppStore((s) => s.addTeam)
  const [mode, setMode] = useState<Mode>('picker')
  const [nlInput, setNlInput] = useState('')
  const [loading, setLoading] = useState(false)

  if (!open || !companyId) return null

  const applyPreset = (p: PresetDef) => {
    addTeam(companyId, p.build())
    reset()
  }

  const applyNl = () => {
    if (!nlInput.trim()) return
    setLoading(true)
    setTimeout(() => {
      addTeam(companyId, buildTeamFromNaturalLanguage(nlInput))
      setLoading(false)
      reset()
    }, 1200)
  }

  const reset = () => {
    setMode('picker')
    setNlInput('')
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New team"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={reset}
      onKeyDown={(e) => e.key === 'Escape' && reset()}
    >
      <div
        className="w-[620px] max-w-[94vw] rounded-2xl bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold">New team</h2>
          <button
            type="button"
            onClick={reset}
            aria-label="Close"
            className="p-1 rounded-md hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="px-5 pt-4">
          <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 text-sm">
            <button
              type="button"
              onClick={() => setMode('picker')}
              className={
                mode === 'picker'
                  ? 'px-3 py-1 rounded-md bg-neutral-900 text-white'
                  : 'px-3 py-1 rounded-md text-neutral-600 hover:bg-neutral-100'
              }
            >
              From preset
            </button>
            <button
              type="button"
              onClick={() => setMode('nl')}
              className={
                mode === 'nl'
                  ? 'px-3 py-1 rounded-md bg-neutral-900 text-white'
                  : 'px-3 py-1 rounded-md text-neutral-600 hover:bg-neutral-100'
              }
            >
              From description
            </button>
          </div>
        </div>

        {mode === 'picker' && (
          <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p)}
                className="text-left rounded-xl border border-neutral-200 bg-white p-4 hover:border-neutral-400 hover:shadow-sm transition-all"
              >
                <div className="text-2xl mb-2">{p.icon}</div>
                <div className="font-semibold text-neutral-900 text-sm">{p.name}</div>
                <div className="text-xs text-neutral-500 mt-1 leading-relaxed">{p.tagline}</div>
                <div className="text-[11px] text-neutral-400 mt-2">
                  {p.build().agents.length} agents
                </div>
              </button>
            ))}
          </div>
        )}

        {mode === 'nl' && (
          <div className="px-5 py-4 space-y-3">
            <div className="flex items-start gap-2 text-xs text-neutral-500 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
              <Sparkles className="w-3.5 h-3.5 mt-0.5 text-amber-600 shrink-0" />
              <div>
                Stubbed — returns a best-fit preset in this build. Real meta-agent lands in
                Phase 7.
              </div>
            </div>
            <textarea
              value={nlInput}
              onChange={(e) => setNlInput(e.target.value)}
              rows={4}
              placeholder="Describe the team you want. e.g. 'Build me an R&D team researching 2nm GAA transistors.'"
              className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
              <Button variant="primary" onClick={applyNl} disabled={loading || !nlInput.trim()}>
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {loading ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
