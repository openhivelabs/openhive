import { create } from 'zustand'
import type { Agent, ReportingEdge } from '../types'
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

function updateCurrentTeam(updater: (team: import('../types').Team) => import('../types').Team) {
  const state = useAppStore.getState()
  const companies = state.companies.map((company) => {
    if (company.id !== state.currentCompanyId) return company
    return {
      ...company,
      teams: company.teams.map((team) => (team.id === state.currentTeamId ? updater(team) : team)),
    }
  })
  useAppStore.setState({ companies })
}

export const useCanvasStore = create<CanvasState>(() => ({
  addAgent: (agent) =>
    updateCurrentTeam((team) => ({ ...team, agents: [...team.agents, agent] })),

  updateAgent: (agentId, patch) =>
    updateCurrentTeam((team) => ({
      ...team,
      agents: team.agents.map((a) => (a.id === agentId ? { ...a, ...patch } : a)),
    })),

  moveAgent: (agentId, position) =>
    updateCurrentTeam((team) => ({
      ...team,
      agents: team.agents.map((a) => (a.id === agentId ? { ...a, position } : a)),
    })),

  removeAgent: (agentId) =>
    updateCurrentTeam((team) => ({
      ...team,
      agents: team.agents.filter((a) => a.id !== agentId),
      edges: team.edges.filter((e) => e.source !== agentId && e.target !== agentId),
    })),

  addEdge: (edge) => updateCurrentTeam((team) => ({ ...team, edges: [...team.edges, edge] })),

  removeEdge: (edgeId) =>
    updateCurrentTeam((team) => ({ ...team, edges: team.edges.filter((e) => e.id !== edgeId) })),

  setActiveAgents: (agentIds) =>
    updateCurrentTeam((team) => ({
      ...team,
      agents: team.agents.map((a) => ({ ...a, isActive: agentIds.includes(a.id) })),
    })),

  setActiveEdges: (edgeIds) =>
    updateCurrentTeam((team) => ({
      ...team,
      edges: team.edges.map((e) => ({ ...e, isActive: edgeIds.includes(e.id) })),
    })),
}))
