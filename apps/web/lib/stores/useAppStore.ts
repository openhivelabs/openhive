import { create } from 'zustand'
import { mockCompanies } from '../mock/companies'
import type { CanvasMode, Company } from '../types'

interface AppState {
  companies: Company[]
  currentCompanyId: string
  currentTeamId: string
  mode: CanvasMode
  sidebarOpen: boolean
  drawerOpen: boolean

  setCompany: (id: string) => void
  setTeam: (id: string) => void
  setMode: (mode: CanvasMode) => void
  toggleSidebar: () => void
  toggleDrawer: () => void

  addCompany: (company: Company) => void
  addTeam: (companyId: string, team: Company['teams'][number]) => void
}

export const useAppStore = create<AppState>((set) => ({
  companies: mockCompanies,
  currentCompanyId: mockCompanies[0]!.id,
  currentTeamId: mockCompanies[0]!.teams[0]!.id,
  mode: 'design',
  sidebarOpen: true,
  drawerOpen: true,

  setCompany: (id) =>
    set((state) => {
      const company = state.companies.find((c) => c.id === id)
      if (!company) return {}
      return {
        currentCompanyId: id,
        currentTeamId: company.teams[0]?.id ?? state.currentTeamId,
      }
    }),
  setTeam: (id) => set({ currentTeamId: id }),
  setMode: (mode) => set({ mode }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),

  addCompany: (company) =>
    set((s) => ({
      companies: [...s.companies, company],
      currentCompanyId: company.id,
      currentTeamId: company.teams[0]?.id ?? s.currentTeamId,
    })),
  addTeam: (companyId, team) =>
    set((s) => ({
      companies: s.companies.map((c) =>
        c.id === companyId ? { ...c, teams: [...c.teams, team] } : c,
      ),
      currentCompanyId: companyId,
      currentTeamId: team.id,
    })),
}))

export function useCurrentTeam() {
  return useAppStore((s) => {
    const company = s.companies.find((c) => c.id === s.currentCompanyId)
    return company?.teams.find((t) => t.id === s.currentTeamId)
  })
}
