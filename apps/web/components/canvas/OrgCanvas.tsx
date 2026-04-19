'use client'

import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type EdgeChange,
  MiniMap,
  type NodeChange,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react'
import { type DragEvent, useCallback, useMemo, useState } from 'react'
import { NodeEditor } from '@/components/modals/NodeEditor'
import { mockProviders } from '@/lib/mock/companies'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import type { Agent } from '@/lib/types'
import { AgentNode, type AgentFlowNode } from './AgentNode'
import { NodePalette } from './NodePalette'
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

function rid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

export function OrgCanvas() {
  const team = useCurrentTeam()
  const mode = useAppStore((s) => s.mode)
  const { moveAgent, addAgent, addEdge, removeAgent, removeEdge } = useCanvasStore()
  const { screenToFlowPosition } = useReactFlow()
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)

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
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false) {
          const n = next.find((x) => x.id === change.id)
          if (n) moveAgent(n.id, n.position)
        }
        if (change.type === 'remove' && mode === 'design') {
          removeAgent(change.id)
        }
      }
    },
    [nodes, moveAgent, removeAgent, mode],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<ReportingFlowEdge>[]) => {
      for (const change of changes) {
        if (change.type === 'remove' && mode === 'design') removeEdge(change.id)
      }
      applyEdgeChanges(changes, edges)
    },
    [edges, removeEdge, mode],
  )

  const onConnect = useCallback(
    (conn: Connection) => {
      if (mode !== 'design' || !conn.source || !conn.target) return
      addEdge({ id: rid('e'), source: conn.source, target: conn.target })
    },
    [addEdge, mode],
  )

  const onDragOver = useCallback((ev: DragEvent<HTMLDivElement>) => {
    if (ev.dataTransfer.types.includes('application/openhive-role')) {
      ev.preventDefault()
      ev.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const onDrop = useCallback(
    (ev: DragEvent<HTMLDivElement>) => {
      if (mode !== 'design') return
      const role = ev.dataTransfer.getData('application/openhive-role')
      if (!role) return
      ev.preventDefault()
      const position = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      const defaultProvider = mockProviders[0]!
      addAgent({
        id: rid('a'),
        role,
        label: defaultProvider.label,
        providerId: defaultProvider.id,
        model: 'claude-sonnet-4-6',
        systemPrompt: `You are a ${role}.`,
        skills: [],
        position,
      })
    },
    [addAgent, mode, screenToFlowPosition],
  )

  if (!team) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-400 text-sm">
        No team selected.
      </div>
    )
  }

  return (
    <div className="h-full w-full relative" onDragOver={onDragOver} onDrop={onDrop}>
      <NodePalette visible={mode === 'design'} />

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDoubleClick={(_, node) => {
          if (mode !== 'design') return
          const a = team.agents.find((x) => x.id === node.id)
          if (a) setEditingAgent(a)
        }}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={mode === 'design'}
        nodesConnectable={mode === 'design'}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e5e5e5" />
        <Controls showInteractive={false} className="!bg-white !border !border-neutral-200" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          className="!bg-white !border !border-neutral-200"
          nodeColor="#e5e5e5"
          nodeStrokeWidth={1}
        />
      </ReactFlow>

      <NodeEditor agent={editingAgent} onClose={() => setEditingAgent(null)} />
    </div>
  )
}
