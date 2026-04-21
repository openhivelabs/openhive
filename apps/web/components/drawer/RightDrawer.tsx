'use client'

import { CalendarBlank, ChatCircleText, Files, Table } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type { DrawerTab } from '@/lib/types'
import { useT } from '@/lib/i18n'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import { ArtifactsTab } from './ArtifactsTab'
import { ChatTab } from './ChatTab'
import { DataTab } from './DataTab'
import { TriggersTab } from './TriggersTab'

const TABS: { value: DrawerTab; key: string; icon: typeof ChatCircleText }[] = [
  { value: 'chat', key: 'drawer.chat', icon: ChatCircleText },
  { value: 'data', key: 'drawer.data', icon: Table },
  { value: 'triggers', key: 'drawer.triggers', icon: CalendarBlank },
  { value: 'artifacts', key: 'drawer.artifacts', icon: Files },
]

export function RightDrawer() {
  const t = useT()
  const { tab, setTab } = useDrawerStore()

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center border-b border-neutral-200 bg-white">
        {TABS.map(({ value, key, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={clsx(
              'flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 text-[15px] transition-colors border-b-2 cursor-pointer',
              tab === value
                ? 'text-neutral-900 border-neutral-900'
                : 'text-neutral-500 hover:text-neutral-800 border-transparent',
            )}
          >
            <Icon className="w-4 h-4" />
            {t(key)}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'chat' && <ChatTab />}
        {tab === 'data' && <DataTab />}
        {tab === 'triggers' && <TriggersTab />}
        {tab === 'artifacts' && <ArtifactsTab />}
      </div>
    </div>
  )
}
