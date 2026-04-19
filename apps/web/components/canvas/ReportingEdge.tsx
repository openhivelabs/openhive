'use client'

import { BaseEdge, type Edge, type EdgeProps, getSmoothStepPath } from '@xyflow/react'

export type ReportingEdgeData = { isActive?: boolean }
export type ReportingFlowEdge = Edge<ReportingEdgeData, 'reporting'>

export function ReportingEdge(props: EdgeProps<ReportingFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, id, data } = props
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  })

  const active = data?.isActive

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: active ? '#10b981' : '#d4d4d4',
          strokeWidth: active ? 2 : 1.5,
        }}
      />
      {active && (
        <circle r="5" fill="#10b981">
          <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  )
}
