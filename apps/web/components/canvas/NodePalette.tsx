'use client'

import { clsx } from 'clsx'
import {
  Briefcase,
  Code2,
  Compass,
  Crown,
  Hammer,
  Microscope,
  PenTool,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react'
import type { ComponentType, DragEvent } from 'react'

interface PaletteItem {
  role: string
  icon: ComponentType<{ className?: string }>
}

const ITEMS: PaletteItem[] = [
  { role: 'CEO', icon: Crown },
  { role: 'CTO', icon: Code2 },
  { role: 'CMO', icon: Compass },
  { role: 'COO', icon: Briefcase },
  { role: 'Manager', icon: Users },
  { role: 'Engineer', icon: Hammer },
  { role: 'Researcher', icon: Search },
  { role: 'Writer', icon: PenTool },
  { role: 'Reviewer', icon: ShieldCheck },
  { role: 'Analyst', icon: Microscope },
]

function onDragStart(ev: DragEvent<HTMLButtonElement>, role: string) {
  ev.dataTransfer.setData('application/openhive-role', role)
  ev.dataTransfer.effectAllowed = 'copy'
}

interface NodePaletteProps {
  visible: boolean
}

export function NodePalette({ visible }: NodePaletteProps) {
  return (
    <div
      className={clsx(
        'absolute top-4 left-4 z-10 rounded-xl bg-white border border-neutral-200 shadow-sm p-2 transition-opacity',
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}
    >
      <div className="px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        Drag a role
      </div>
      <div className="grid grid-cols-2 gap-1">
        {ITEMS.map(({ role, icon: Icon }) => (
          <button
            key={role}
            type="button"
            draggable
            onDragStart={(e) => onDragStart(e, role)}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-neutral-700 hover:bg-neutral-100 cursor-grab active:cursor-grabbing"
          >
            <Icon className="w-3.5 h-3.5 text-neutral-500" />
            <span>{role}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
