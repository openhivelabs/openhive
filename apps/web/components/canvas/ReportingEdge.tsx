import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
} from '@xyflow/react'
import { X } from '@phosphor-icons/react'
import { useState } from 'react'
import { useAppStore } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'

export type ReportingEdgeData = { isActive?: boolean }
export type ReportingFlowEdge = Edge<ReportingEdgeData, 'reporting'>

export function ReportingEdge(props: EdgeProps<ReportingFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, id, data } = props
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  })

  const active = data?.isActive
  const mode = useAppStore((s) => s.mode)
  const removeEdge = useCanvasStore((s) => s.removeEdge)
  const [hover, setHover] = useState(false)

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: active ? '#10b981' : hover ? '#a3a3a3' : '#d4d4d4',
          strokeWidth: active ? 2 : hover ? 2 : 1.5,
        }}
      />
      {/* Wide invisible hit-area so the edge is easy to hover/click. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: mode === 'design' ? 'pointer' : 'default' }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />
      {active && (
        <circle r="5" fill="#10b981">
          <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {mode === 'design' && hover && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              removeEdge(id)
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            aria-label="Remove edge"
            title="보고 라인 삭제"
            className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto w-6 h-6 rounded-full bg-white border border-neutral-300 shadow-sm text-neutral-600 hover:text-red-600 hover:border-red-400 flex items-center justify-center cursor-pointer"
            style={{ left: labelX, top: labelY }}
          >
            <X className="w-3 h-3" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
