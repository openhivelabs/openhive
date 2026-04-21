import { create } from 'zustand'
import { saveTeam } from '../api/companies'
import type { Agent, ReportingEdge, Team } from '../types'
import { useAppStore } from './useAppStore'

interface CanvasState {
  addAgent: (agent: Agent) => void
  updateAgent: (agentId: string, patch: Partial<Agent>) => void
  moveAgent: (agentId: string, position: { x: number; y: number }) => void
  removeAgent: (agentId: string) => void
  addEdge: (edge: ReportingEdge) => void
  removeEdge: (edgeId: string) => void
  setActiveAgents: (agentIds: string[]) => void
  setActiveEdges: (edgeIds: string[]) => void
}

type Updater = (team: Team) => Team

function mutate(updater: Updater, persist: boolean) {
  const state = useAppStore.getState()
  let savedTeam: Team | null = null
  let savedCompanySlug: string | null = null
  const companies = state.companies.map((company) => {
    if (company.id !== state.currentCompanyId) return company
    return {
      ...company,
      teams: company.teams.map((team) => {
        if (team.id !== state.currentTeamId) return team
        const next = updater(team)
        savedTeam = next
        savedCompanySlug = company.slug
        return next
      }),
    }
  })
  useAppStore.setState({ companies })
  if (persist && savedTeam && savedCompanySlug) {
    void saveTeam(savedCompanySlug, savedTeam).catch((e) => console.error('saveTeam failed', e))
  }
}

export const useCanvasStore = create<CanvasState>(() => ({
  addAgent: (agent) =>
    mutate((team) => ({ ...team, agents: [...team.agents, agent] }), true),

  updateAgent: (agentId, patch) =>
    mutate(
      (team) => ({
        ...team,
        agents: team.agents.map((a) => (a.id === agentId ? { ...a, ...patch } : a)),
      }),
      true,
    ),

  moveAgent: (agentId, position) =>
    mutate(
      (team) => ({
        ...team,
        agents: team.agents.map((a) => (a.id === agentId ? { ...a, position } : a)),
      }),
      true,
    ),

  removeAgent: (agentId) =>
    mutate(
      (team) => ({
        ...team,
        agents: team.agents.filter((a) => a.id !== agentId),
        edges: team.edges.filter((e) => e.source !== agentId && e.target !== agentId),
      }),
      true,
    ),

  addEdge: (edge) => mutate((team) => ({ ...team, edges: [...team.edges, edge] }), true),

  removeEdge: (edgeId) =>
    mutate((team) => ({ ...team, edges: team.edges.filter((e) => e.id !== edgeId) }), true),

  // Transient highlights — not persisted.
  setActiveAgents: (agentIds) =>
    mutate(
      (team) => ({
        ...team,
        agents: team.agents.map((a) => ({ ...a, isActive: agentIds.includes(a.id) })),
      }),
      false,
    ),

  setActiveEdges: (edgeIds) =>
    mutate(
      (team) => ({
        ...team,
        edges: team.edges.map((e) => ({ ...e, isActive: edgeIds.includes(e.id) })),
      }),
      false,
    ),
}))
