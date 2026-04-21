'use client'

import { Database, FolderOpen } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useState } from 'react'
import { DatabaseView } from '@/components/database/DatabaseView'
import { FileBrowser } from '@/components/database/FileBrowser'

type StorageView = 'database' | 'files'

const VIEWS: { id: StorageView; label: string; icon: typeof Database }[] = [
  { id: 'database', label: 'Database', icon: Database },
  { id: 'files', label: 'Files', icon: FolderOpen },
]

export default function StoragePage() {
  const [view, setView] = useState<StorageView>('database')
  return (
    <div className="h-full flex flex-col bg-white dark:bg-neutral-950">
      <nav className="h-[44px] shrink-0 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 flex items-center gap-0.5">
        {VIEWS.map(({ id, label, icon: Icon }) => {
          const active = view === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={clsx(
                'h-7 px-2.5 rounded-md text-[13px] flex items-center gap-1.5 cursor-pointer transition-colors',
                active
                  ? 'bg-neutral-100 dark:bg-neutral-800/80 text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-900',
              )}
            >
              <Icon className="w-3.5 h-3.5" weight={active ? 'fill' : 'regular'} />
              {label}
            </button>
          )
        })}
      </nav>
      <div className="flex-1 min-h-0">
        {view === 'database' ? <DatabaseView /> : <FileBrowser />}
      </div>
    </div>
  )
}
