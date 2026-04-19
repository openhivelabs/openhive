'use client'

import { clsx } from 'clsx'
import { ChevronDown, ChevronUp, Clock } from 'lucide-react'
import { useState } from 'react'
import { useCurrentTeam } from '@/lib/stores/useAppStore'

interface TimelineBar {
  agentId: string
  startPct: number
  widthPct: number
  status: 'done' | 'running' | 'queued'
}

function mockBars(agents: { id: string }[]): TimelineBar[] {
  // Fake gantt layout — spreads a synthetic run across the viewport
  if (agents.length === 0) return []
  const stride = 80 / Math.max(agents.length, 1)
  return agents.map((a, i) => ({
    agentId: a.id,
    startPct: 5 + i * stride * 0.6,
    widthPct: stride * 0.9,
    status: i === 0 ? 'done' : i === 1 ? 'running' : 'queued',
  }))
}

export function Timeline() {
  const team = useCurrentTeam()
  const [open, setOpen] = useState(false)

  if (!team) return null
  const bars = mockBars(team.agents)

  return (
    <div className="bg-white border-t border-neutral-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-1.5 hover:bg-neutral-50"
      >
        <div className="flex items-center gap-2 text-xs text-neutral-600">
          <Clock className="w-3.5 h-3.5" />
          <span className="font-medium">Timeline</span>
          <span className="text-neutral-400">· {bars.length} tasks · last run 2m ago</span>
        </div>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-neutral-400" />
        )}
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1">
          <div className="relative">
            {/* Time axis */}
            <div className="flex justify-between text-[10px] font-mono text-neutral-400 px-1 mb-1">
              {['00:00', '00:30', '01:00', '01:30', '02:00'].map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <div className="relative h-[140px] border border-neutral-200 rounded-md bg-neutral-50 overflow-hidden">
              {/* Gridlines */}
              {[0, 25, 50, 75, 100].map((p) => (
                <div
                  key={p}
                  className="absolute top-0 bottom-0 w-px bg-neutral-200"
                  style={{ left: `${p}%` }}
                />
              ))}
              {/* Bars */}
              {bars.map((bar, idx) => {
                const agent = team.agents.find((a) => a.id === bar.agentId)
                const top = 8 + idx * 22
                return (
                  <div
                    key={bar.agentId}
                    className={clsx(
                      'absolute rounded-md px-2 py-0.5 text-[11px] font-medium flex items-center gap-1.5 shadow-sm',
                      bar.status === 'running' && 'bg-emerald-500 text-white',
                      bar.status === 'done' && 'bg-neutral-300 text-neutral-700',
                      bar.status === 'queued' &&
                        'bg-white border border-neutral-300 text-neutral-500',
                    )}
                    style={{
                      left: `${bar.startPct}%`,
                      width: `${bar.widthPct}%`,
                      top: `${top}px`,
                      height: '18px',
                    }}
                  >
                    <span className="truncate">{agent?.role ?? '—'}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
