'use client'

import { Database, FolderOpen } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useState } from 'react'
import { DatabaseView } from '@/components/database/DatabaseView'
import { FileBrowser } from '@/components/database/FileBrowser'

type StorageView = 'database' | 'files'

const VIEWS: { id: StorageView; label: string; icon: typeof Database }[] = [
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'database', label: 'Database', icon: Database },
]

export default function StoragePage() {
  const [view, setView] = useState<StorageView>('files')
  return (
    <div className="h-full flex flex-col bg-white dark:bg-neutral-950">
      <nav className="h-[48px] shrink-0 border-b border-neutral-200 dark:border-neutral-800 px-6 flex items-center">
        <div className="inline-flex p-0.5 rounded-lg bg-neutral-100/80 dark:bg-neutral-900">
          {VIEWS.map(({ id, label, icon: Icon }) => {
            const active = view === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={clsx(
                  'h-7 px-3 rounded-md text-[13px] flex items-center gap-1.5 cursor-pointer transition-all',
                  active
                    ? 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                    : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100',
                )}
              >
                <Icon className="w-3.5 h-3.5" weight={active ? 'fill' : 'regular'} />
                {label}
              </button>
            )
          })}
        </div>
      </nav>
      <div className="flex-1 min-h-0">
        {view === 'database' ? <DatabaseView /> : <FileBrowser />}
      </div>
    </div>
  )
}
