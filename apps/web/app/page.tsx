'use client'

import { ReactFlowProvider } from '@xyflow/react'
import { clsx } from 'clsx'
import { OrgCanvas } from '@/components/canvas/OrgCanvas'
import { RightDrawer } from '@/components/drawer/RightDrawer'
import { Sidebar } from '@/components/shell/Sidebar'
import { Timeline } from '@/components/shell/Timeline'
import { TopBar } from '@/components/shell/TopBar'
import { useAppStore } from '@/lib/stores/useAppStore'
import { useKeyboardShortcuts } from '@/lib/stores/useKeyboardShortcuts'

export default function Home() {
  const { sidebarOpen, drawerOpen } = useAppStore()
  useKeyboardShortcuts()

  return (
    <div
      className={clsx(
        'h-screen grid transition-[grid-template-columns] duration-200',
        'grid-rows-[52px_1fr_auto]',
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
        {drawerOpen && <RightDrawer />}
      </aside>
      <div className="col-span-3">
        <Timeline />
      </div>
    </div>
  )
}
