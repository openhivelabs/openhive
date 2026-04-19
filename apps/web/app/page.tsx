'use client'

import { ReactFlowProvider } from '@xyflow/react'
import { clsx } from 'clsx'
import { OrgCanvas } from '@/components/canvas/OrgCanvas'
import { Sidebar } from '@/components/shell/Sidebar'
import { TopBar } from '@/components/shell/TopBar'
import { useAppStore } from '@/lib/stores/useAppStore'

export default function Home() {
  const { sidebarOpen, drawerOpen } = useAppStore()

  return (
    <div
      className={clsx(
        'h-screen grid transition-[grid-template-columns] duration-200',
        'grid-rows-[52px_1fr]',
      )}
      style={{
        gridTemplateColumns: `${sidebarOpen ? '240px' : '0px'} 1fr ${drawerOpen ? '360px' : '0px'}`,
      }}
    >
      <div className="col-span-3 border-b border-neutral-200 bg-white">
        <TopBar />
      </div>
      <aside className="border-r border-neutral-200 bg-white overflow-hidden">
        {sidebarOpen && <Sidebar />}
      </aside>
      <main className="overflow-hidden relative bg-neutral-50">
        <ReactFlowProvider>
          <OrgCanvas />
        </ReactFlowProvider>
      </main>
      <aside className="border-l border-neutral-200 bg-white overflow-hidden">
        {drawerOpen && (
          <div className="h-full flex items-center justify-center text-neutral-400 text-sm">
            Drawer coming in Task 9
          </div>
        )}
      </aside>
    </div>
  )
}
