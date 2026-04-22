import { useEffect, useRef } from 'react'
import { useAppStore } from './useAppStore'
import { useCanvasStore } from './useCanvasStore'

/**
 * When mode === 'run', cycles isActive flags across nodes in BFS order from roots,
 * also lighting up the edge between the freshly-activated pair. Pure visual — no real work.
 */
export function useRunSimulator() {
  const mode = useAppStore((s) => s.mode)
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const stepRef = useRef(0)

  useEffect(() => {
    const { setActiveAgents, setActiveEdges } = useCanvasStore.getState()

    if (mode !== 'run') {
      setActiveAgents([])
      setActiveEdges([])
      return
    }

    const state = useAppStore.getState()
    const team = state.companies
      .find((c) => c.id === state.currentCompanyId)
      ?.teams.find((t) => t.id === state.currentTeamId)
    if (!team) return

    const agents = team.agents
    const edges = team.edges

    const incoming = new Map<string, string[]>()
    for (const a of agents) incoming.set(a.id, [])
    for (const e of edges) incoming.get(e.target)?.push(e.source)
    const roots = agents.filter((a) => (incoming.get(a.id)?.length ?? 0) === 0).map((a) => a.id)

    const order: string[] = []
    const seen = new Set<string>()
    const queue = [...roots]
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      order.push(id)
      for (const e of edges) if (e.source === id) queue.push(e.target)
    }
    if (order.length === 0) return

    stepRef.current = 0
    const tick = () => {
      const idx = stepRef.current % order.length
      const active = order[idx]!
      const prevIdx = (idx - 1 + order.length) % order.length
      const prev = order[prevIdx]!
      setActiveAgents([active])
      const activeEdgeIds = edges
        .filter((e) => e.source === prev && e.target === active)
        .map((e) => e.id)
      setActiveEdges(activeEdgeIds)
      stepRef.current += 1
    }

    tick()
    const interval = setInterval(tick, 1600)
    return () => {
      clearInterval(interval)
      const { setActiveAgents: clear, setActiveEdges: clearE } = useCanvasStore.getState()
      clear([])
      clearE([])
    }
  }, [mode, currentTeamId])
}
