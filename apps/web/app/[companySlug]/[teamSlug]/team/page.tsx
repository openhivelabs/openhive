'use client'

import { ReactFlowProvider } from '@xyflow/react'
import { OrgCanvas } from '@/components/canvas/OrgCanvas'

export default function DesignPage() {
  return (
    <div className="h-full">
      <ReactFlowProvider>
        <OrgCanvas />
      </ReactFlowProvider>
    </div>
  )
}
