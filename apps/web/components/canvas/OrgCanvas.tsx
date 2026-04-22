import {
  Background,
  BackgroundVariant,
  type Connection,
  type EdgeChange,
  type NodeChange,
  ReactFlow,
} from '@xyflow/react'
import { useCallback, useMemo, useState } from 'react'
import { NodeEditor } from '@/components/modals/NodeEditor'
import { mockProviders } from '@/lib/mock/companies'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import type { Agent } from '@/lib/types'
import { AddAgentButton } from './AddAgentButton'
import { AgentFrameGalleryModal } from './AgentFrameGalleryModal'
import { AgentNode, type AgentFlowNode } from './AgentNode'
import { AskAiAgentModal } from './AskAiAgentModal'
import { ReportingEdge, type ReportingFlowEdge } from './ReportingEdge'

const nodeTypes = { agent: AgentNode }
const edgeTypes = { reporting: ReportingEdge }

const PROVIDER_COLORS: Record<string, string> = {
  'Claude Code': '#f59e0b',
  Codex: '#10a37f',
  Copilot: '#6366f1',
}

function rid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

// Team yaml historically used mixed casing ("Lead" / "lead") for the top agent's
// role. The Lead slot is a single well-known role regardless of how it was
// typed, so normalize before comparing.
function isLeadRole(role: string | undefined): boolean {
  return (role ?? '').trim().toLowerCase() === 'lead'
}

// Hierarchical auto-layout. Org chart = tree rooted at Lead. We assign each
// agent a level by BFS from roots, then spread each level horizontally.
function autoLayout(
  agents: { id: string; role?: string }[],
  edges: { source: string; target: string }[],
): Record<string, { x: number; y: number }> {
  const NODE_W = 240
  const H_GAP = 60
  const LEVEL_H = 140
  // Extra breathing room between the main tree and the orphan parking lane so
  // readers immediately see the two groups as separate.
  const ORPHAN_GUTTER = 140
  const incoming: Record<string, string[]> = {}
  const outgoing: Record<string, string[]> = {}
  for (const a of agents) {
    incoming[a.id] = []
    outgoing[a.id] = []
  }
  for (const e of edges) {
    // Skip self-loops outright. They contribute no hierarchy info and used to
    // inflate the loop's level until the safety cap, parking that node way
    // off-screen ("땅끝마을").
    if (e.source === e.target) continue
    if (outgoing[e.source]) outgoing[e.source]!.push(e.target)
    if (incoming[e.target]) incoming[e.target]!.push(e.source)
  }
  // Roots = no incoming. The Lead-role root sits at level 0; any OTHER orphan
  // (e.g. a freshly added Member not yet wired to anyone) starts at level 1 so
  // it never visually shares the Lead's row — Lead deserves the top line alone.
  const roots = agents.filter((a) => (incoming[a.id] ?? []).length === 0)
  const level: Record<string, number> = {}
  const queue: string[] = []
  for (const r of roots) {
    level[r.id] = isLeadRole(r.role) ? 0 : 1
    queue.push(r.id)
  }
  // Hard iteration cap defends against accidental cycles. Each step is O(1)
  // work; the cap is generous enough that any realistic chart finishes well
  // before, but guarantees we never freeze the page if a bad edge slips in.
  let safety = agents.length * agents.length + 100
  while (queue.length > 0 && safety-- > 0) {
    const id = queue.shift()!
    for (const child of outgoing[id] ?? []) {
      // Strict `<` plus the `undefined` check means we only re-queue when the
      // depth genuinely needs to grow — so a non-cyclic DAG settles quickly.
      // Cycles still get caught by the safety counter above.
      if (level[child] === undefined || level[child]! < level[id]! + 1) {
        level[child] = level[id]! + 1
        queue.push(child)
      }
    }
  }
  // Orphans = non-Lead agents with no edges at all (neither reports to anyone
  // nor has subordinates). They don't participate in the hierarchy, so we park
  // them in a vertical lane to the right of the main tree instead of squeezing
  // them into level rows where they'd visually imply a peer relationship with
  // wired members.
  const orphanIds = agents
    .filter(
      (a) =>
        !isLeadRole(a.role) &&
        (incoming[a.id] ?? []).length === 0 &&
        (outgoing[a.id] ?? []).length === 0,
    )
    .map((a) => a.id)
  const orphanSet = new Set(orphanIds)

  const byLevel: Record<number, string[]> = {}
  for (const a of agents) {
    if (orphanSet.has(a.id)) continue
    // Default unassigned agents to level 1 too (not 0) so unwired Members never
    // ride up to the Lead row even if BFS missed them.
    const lv = level[a.id] ?? (isLeadRole(a.role) ? 0 : 1)
    ;(byLevel[lv] ??= []).push(a.id)
  }
  const out: Record<string, { x: number; y: number }> = {}
  // Track the main tree's right edge so the orphan lane starts clearly past it.
  let mainRightEdge = 0
  for (const lvStr of Object.keys(byLevel)) {
    const lv = Number(lvStr)
    const ids = byLevel[lv]!
    const totalW = ids.length * NODE_W + (ids.length - 1) * H_GAP
    const startX = -totalW / 2
    ids.forEach((id, i) => {
      out[id] = { x: startX + i * (NODE_W + H_GAP), y: lv * LEVEL_H }
    })
    mainRightEdge = Math.max(mainRightEdge, startX + totalW)
  }
  // If the main tree is empty (shouldn't happen — Lead always exists), fall
  // back to centering orphans; otherwise park them in a single column offset
  // from the tree by ORPHAN_GUTTER.
  const orphanX = (mainRightEdge || -NODE_W / 2) + ORPHAN_GUTTER
  orphanIds.forEach((id, i) => {
    // Start the lane at level 1 (below Lead) so the top of the orphan column
    // lines up with the first member row rather than the Lead row.
    out[id] = { x: orphanX, y: (i + 1) * LEVEL_H }
  })
  return out
}

export function OrgCanvas() {
  const team = useCurrentTeam()
  const mode = useAppStore((s) => s.mode)
  const companySlug = useAppStore((s) => {
    const c = s.companies.find((x) => x.id === s.currentCompanyId)
    return c?.slug ?? ''
  })
  const { addAgent, addEdge, removeAgent, removeEdge } = useCanvasStore()
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [askAiOpen, setAskAiOpen] = useState(false)
  const [frameGalleryOpen, setFrameGalleryOpen] = useState(false)

  const positions = useMemo(() => {
    if (!team) return {}
    return autoLayout(
      team.agents.map((a) => ({ id: a.id, role: a.role })),
      team.edges,
    )
  }, [team])

  const nodes: AgentFlowNode[] = useMemo(() => {
    if (!team) return []
    return team.agents.map((a) => ({
      id: a.id,
      type: 'agent' as const,
      position: positions[a.id] ?? { x: 0, y: 0 },
      data: {
        role: a.role,
        label: a.label,
        providerColor: PROVIDER_COLORS[a.label],
        isActive: a.isActive,
        // Only the role-Lead hides its top handle. Using "no incoming edges"
        // would also hide it for orphan Members, leaving them impossible to
        // wire into the chart (catch-22).
        isLead: isLeadRole(a.role),
      },
      draggable: false,
    }))
  }, [team, positions])

  const edges: ReportingFlowEdge[] = useMemo(() => {
    if (!team) return []
    const agentIds = new Set(team.agents.map((a) => a.id))
    return team.edges
      // Defensive filter: drop self-loops and edges to/from missing agents so a
      // legacy yaml can never draw a line off into the void.
      .filter((e) => e.source !== e.target && agentIds.has(e.source) && agentIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'reporting' as const,
        data: { isActive: e.isActive },
      }))
  }, [team])

  const onNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      // Positions are auto-computed; only handle removals here.
      for (const change of changes) {
        if (change.type === 'remove' && mode === 'design') {
          // Lead is immutable — every team keeps exactly one Lead for its lifetime.
          const target = nodes.find((n) => n.id === change.id)
          if (isLeadRole(target?.data?.role)) continue
          removeAgent(change.id)
        }
      }
    },
    [nodes, removeAgent, mode],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<ReportingFlowEdge>[]) => {
      // Edges are fully derived from team.edges via useMemo, so we don't need
      // to mutate a local edges array for selection/hover state — ReactFlow
      // handles that internally. We only act on removals.
      for (const change of changes) {
        if (change.type === 'remove' && mode === 'design') removeEdge(change.id)
      }
    },
    [removeEdge, mode],
  )

  const onConnect = useCallback(
    (conn: Connection) => {
      if (mode !== 'design' || !conn.source || !conn.target) return
      if (conn.source === conn.target) return  // self-loop
      // Cycle guard: refuse the edge if `target` can already reach `source` via
      // existing edges. Without this the layout BFS would loop and freeze the page.
      if (team) {
        const reach: Record<string, string[]> = {}
        for (const e of team.edges) (reach[e.source] ??= []).push(e.target)
        const seen = new Set<string>()
        const stack = [conn.target]
        while (stack.length > 0) {
          const cur = stack.pop()!
          if (cur === conn.source) {
            // Surface a small toast-style hint via console; cleaner UI later.
            console.warn(
              `[org] Refusing edge ${conn.source} → ${conn.target}: would create a cycle.`,
            )
            return
          }
          if (seen.has(cur)) continue
          seen.add(cur)
          for (const next of reach[cur] ?? []) stack.push(next)
        }
      }
      addEdge({ id: rid('e'), source: conn.source, target: conn.target })
    },
    [addEdge, mode, team],
  )

  const addManualMember = useCallback(() => {
    const defaultProvider = mockProviders.find((p) => p.id === 'copilot') ?? mockProviders[0]!
    const newAgent: Agent = {
      id: rid('a'),
      role: 'Member',
      label: defaultProvider.label,
      providerId: defaultProvider.id,
      model: 'gpt-5-mini',
      systemPrompt: 'You are a Member.',
      skills: [],
      position: { x: 0, y: 0 },
    }
    addAgent(newAgent)
    setEditingAgent(newAgent)
  }, [addAgent])

  const addViaAi = useCallback(() => {
    setAskAiOpen(true)
  }, [])

  const onAiCreated = useCallback(
    (agent: Agent, warnings?: string[]) => {
      addAgent(agent)
      if (warnings && warnings.length > 0) console.warn('[agent generate]', warnings)
      setEditingAgent(agent)
    },
    [addAgent],
  )

  const addFromFrame = useCallback(() => {
    setFrameGalleryOpen(true)
  }, [])

  const onFrameInstalled = useCallback(
    (agent: Agent, warnings: string[]) => {
      // Server has already persisted the new agent into the team yaml; we still
      // call addAgent so the in-memory store matches without waiting for a
      // refetch. Canvas store will also call saveTeam again — harmless (same
      // state) and keeps the write path uniform with manual/AI creation.
      addAgent(agent)
      if (warnings.length > 0) console.warn('[agent frame install]', warnings)
      setEditingAgent(agent)
    },
    [addAgent],
  )

  if (!team) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-400 text-[15px]">
        No team selected.
      </div>
    )
  }

  return (
    <div className="h-full w-full relative">
      {mode === 'design' && (
        <AddAgentButton
          onAddManual={addManualMember}
          onAddViaAi={addViaAi}
          onAddFromFrame={addFromFrame}
        />
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => {
          if (mode !== 'design') return
          const a = team.agents.find((x) => x.id === node.id)
          if (a) setEditingAgent(a)
        }}
        fitView
        // maxZoom caps auto-fit so a small chart (3-4 nodes) doesn't blow up to
        // fill the viewport. padding gives breathing room around the bounds.
        fitViewOptions={{ padding: 0.4, maxZoom: 0.9 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={mode === 'design'}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e5e5e5" />
      </ReactFlow>

      <NodeEditor agent={editingAgent} onClose={() => setEditingAgent(null)} />
      <AskAiAgentModal
        open={askAiOpen}
        onClose={() => setAskAiOpen(false)}
        onCreate={onAiCreated}
        companySlug={companySlug}
      />
      <AgentFrameGalleryModal
        open={frameGalleryOpen}
        onClose={() => setFrameGalleryOpen(false)}
        companySlug={companySlug}
        teamSlug={team.slug}
        onInstalled={onFrameInstalled}
      />
    </div>
  )
}
