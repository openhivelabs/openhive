'use client'

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type NodeChange,
  ReactFlow,
  applyNodeChanges,
} from '@xyflow/react'
import { useCallback, useMemo } from 'react'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import { AgentNode, type AgentFlowNode } from './AgentNode'
import { ReportingEdge, type ReportingFlowEdge } from './ReportingEdge'

const nodeTypes = { agent: AgentNode }
const edgeTypes = { reporting: ReportingEdge }

const PROVIDER_COLORS: Record<string, string> = {
  Claude: '#f59e0b',
  OpenAI: '#10a37f',
  Cursor: '#6366f1',
  Codex: '#a855f7',
  Ollama: '#64748b',
  OpenClaw: '#ef4444',
}

export function OrgCanvas() {
  const team = useCurrentTeam()
  const mode = useAppStore((s) => s.mode)
  const { moveAgent } = useCanvasStore()

  const nodes: AgentFlowNode[] = useMemo(() => {
    if (!team) return []
    return team.agents.map((a) => ({
      id: a.id,
      type: 'agent' as const,
      position: a.position,
      data: {
        role: a.role,
        label: a.label,
        providerColor: PROVIDER_COLORS[a.label],
        isActive: a.isActive,
      },
      draggable: mode === 'design',
    }))
  }, [team, mode])

  const edges: ReportingFlowEdge[] = useMemo(() => {
    if (!team) return []
    return team.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'reporting' as const,
      data: { isActive: e.isActive },
    }))
  }, [team])

  const onNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      const next = applyNodeChanges(changes, nodes)
      for (const n of next) {
        const original = nodes.find((x) => x.id === n.id)
        if (original && (original.position.x !== n.position.x || original.position.y !== n.position.y)) {
          moveAgent(n.id, n.position)
        }
      }
    },
    [nodes, moveAgent],
  )

  if (!team) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-400 text-sm">
        No team selected.
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={mode === 'design'}
      nodesConnectable={mode === 'design'}
      elementsSelectable
      panOnDrag
      zoomOnScroll
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e5e5e5" />
      <Controls showInteractive={false} className="!bg-white !border !border-neutral-200" />
      <MiniMap
        pannable
        zoomable
        className="!bg-white !border !border-neutral-200"
        nodeColor="#e5e5e5"
        nodeStrokeWidth={1}
      />
    </ReactFlow>
  )
}
