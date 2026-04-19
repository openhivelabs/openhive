'use client'

import { clsx } from 'clsx'
import { Calendar, FileBox, MessagesSquare } from 'lucide-react'
import type { DrawerTab } from '@/lib/types'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import { ArtifactsTab } from './ArtifactsTab'
import { ChatTab } from './ChatTab'
import { TriggersTab } from './TriggersTab'

const TABS: { value: DrawerTab; label: string; icon: typeof MessagesSquare }[] = [
  { value: 'chat', label: 'Chat', icon: MessagesSquare },
  { value: 'triggers', label: 'Triggers', icon: Calendar },
  { value: 'artifacts', label: 'Artifacts', icon: FileBox },
]

export function RightDrawer() {
  const { tab, setTab } = useDrawerStore()

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center border-b border-neutral-200 bg-white">
        {TABS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={clsx(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm transition-colors border-b-2',
              tab === value
                ? 'text-neutral-900 border-neutral-900'
                : 'text-neutral-500 hover:text-neutral-800 border-transparent',
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'chat' && <ChatTab />}
        {tab === 'triggers' && <TriggersTab />}
        {tab === 'artifacts' && <ArtifactsTab />}
      </div>
    </div>
  )
}
