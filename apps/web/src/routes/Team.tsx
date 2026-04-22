import { OrgCanvas } from '@/components/canvas/OrgCanvas'
import { ReactFlowProvider } from '@xyflow/react'

export function Team() {
  return (
    <div className="h-full">
      <ReactFlowProvider>
        <OrgCanvas />
      </ReactFlowProvider>
    </div>
  )
}
