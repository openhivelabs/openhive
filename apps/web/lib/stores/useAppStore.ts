import { create } from 'zustand'
import { fetchCompanies, saveCompany, saveTeam } from '../api/companies'
import type { Locale } from '../i18n'
// Note: mockCompanies is no longer auto-seeded into a fresh hive. First-session
// users go through `/onboarding` to create their first company explicitly.
import type { CanvasMode, Company, Team } from '../types'

const LOCALE_KEY = 'openhive.locale'
const THEME_KEY = 'openhive.theme'
const ACCENT_KEY = 'openhive.accent'
const DEFAULT_MODEL_KEY = 'openhive.defaultModel'
const TEAM_PANEL_COLLAPSED_KEY = 'openhive.sidebar.teamPanelCollapsed'

export type Theme = 'light' | 'dark' | 'system'
export type Accent =
  | 'amber'
  | 'red'
  | 'pink'
  | 'violet'
  | 'blue'
  | 'lime'
  | 'brown'
  | 'graphite'
const ACCENTS: Accent[] = [
  'amber',
  'red',
  'pink',
  'violet',
  'blue',
  'lime',
  'brown',
  'graphite',
]

export interface DefaultModel {
  providerId: string
  model: string
}

function readLocale(): Locale {
  if (typeof window === 'undefined') return 'en'
  const v = window.localStorage.getItem(LOCALE_KEY)
  return v === 'ko' || v === 'en' ? v : 'en'
}

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  const v = window.localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

function resolveTheme(t: Theme): 'light' | 'dark' {
  if (t !== 'system') return t
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyThemeClass(t: Theme) {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(t)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

function readAccent(): Accent {
  if (typeof window === 'undefined') return 'amber'
  const v = window.localStorage.getItem(ACCENT_KEY) as Accent | null
  return v && ACCENTS.includes(v) ? v : 'amber'
}

function writeAccent(a: Accent) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ACCENT_KEY, a)
  } catch {
    /* ignore */
  }
}

function applyAccentAttr(a: Accent) {
  if (typeof document === 'undefined') return
  if (a === 'amber') document.documentElement.removeAttribute('data-accent')
  else document.documentElement.setAttribute('data-accent', a)
}

function readTeamPanelCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(TEAM_PANEL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeTeamPanelCollapsed(v: boolean) {
  if (typeof window === 'undefined') return
  try {
    if (v) window.localStorage.setItem(TEAM_PANEL_COLLAPSED_KEY, '1')
    else window.localStorage.removeItem(TEAM_PANEL_COLLAPSED_KEY)
  } catch {
    /* ignore */
  }
}

function readDefaultModel(): DefaultModel | null {
  if (typeof window === 'undefined') return null
  const v = window.localStorage.getItem(DEFAULT_MODEL_KEY)
  if (!v) return null
  try {
    const parsed = JSON.parse(v)
    if (parsed && typeof parsed.providerId === 'string' && typeof parsed.model === 'string') {
      return parsed
    }
  } catch {
    /* ignore */
  }
  return null
}

function writeDefaultModel(m: DefaultModel | null) {
  if (typeof window === 'undefined') return
  try {
    if (m) window.localStorage.setItem(DEFAULT_MODEL_KEY, JSON.stringify(m))
    else window.localStorage.removeItem(DEFAULT_MODEL_KEY)
  } catch {
    /* ignore */
  }
}

export function hydrateLocaleFromStorage() {
  if (typeof window === 'undefined') return
  const stored = readLocale()
  if (useAppStore.getState().locale !== stored) {
    useAppStore.setState({ locale: stored })
  }
  const theme = readTheme()
  if (useAppStore.getState().theme !== theme) {
    useAppStore.setState({ theme })
  }
  applyThemeClass(theme)
  const accent = readAccent()
  if (useAppStore.getState().accent !== accent) {
    useAppStore.setState({ accent })
  }
  applyAccentAttr(accent)
  const dm = readDefaultModel()
  if (dm !== useAppStore.getState().defaultModel) {
    useAppStore.setState({ defaultModel: dm })
  }
  const collapsed = readTeamPanelCollapsed()
  if (useAppStore.getState().teamPanelCollapsed !== collapsed) {
    useAppStore.setState({ teamPanelCollapsed: collapsed })
  }
}

function writeLocale(l: Locale) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCALE_KEY, l)
  } catch {
    /* ignore */
  }
}

function writeTheme(t: Theme) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_KEY, t)
  } catch {
    /* ignore */
  }
}

interface AppState {
  companies: Company[]
  currentCompanyId: string
  currentTeamId: string
  mode: CanvasMode
  sidebarOpen: boolean
  drawerOpen: boolean
  hydrated: boolean
  locale: Locale
  theme: Theme
  accent: Accent
  defaultModel: DefaultModel | null
  /** 팀 목록 패널 접힘 상태 — localStorage persist. 브라우저별로 유지. */
  teamPanelCollapsed: boolean

  setCompany: (id: string) => void
  setTeam: (id: string) => void
  setMode: (mode: CanvasMode) => void
  toggleSidebar: () => void
  toggleDrawer: () => void
  toggleTeamPanel: () => void
  setLocale: (l: Locale) => void
  setTheme: (t: Theme) => void
  setAccent: (a: Accent) => void
  setDefaultModel: (m: DefaultModel | null) => void

  addCompany: (company: Company) => void
  addTeam: (companyId: string, team: Team) => void
  updateTeam: (companyId: string, team: Team) => void

  hydrate: () => Promise<void>
}

function pickInitial(companies: Company[]) {
  const company = companies[0]
  const team = company?.teams[0]
  return {
    currentCompanyId: company?.id ?? '',
    currentTeamId: team?.id ?? '',
  }
}

export const useAppStore = create<AppState>((set, get) => {
  return {
    companies: [],
    currentCompanyId: '',
    currentTeamId: '',
    mode: 'design',
    sidebarOpen: true,
    drawerOpen: true,
    hydrated: false,
    // Always start with 'en' on first render so SSR + initial client render agree.
    // `hydrateLocaleFromStorage()` is invoked from the root page after mount to
    // swap in the persisted locale without a hydration mismatch.
    locale: 'en',
    theme: 'system',
    accent: 'amber',
    defaultModel: null,
    teamPanelCollapsed: false,

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
    toggleTeamPanel: () =>
      set((s) => {
        const next = !s.teamPanelCollapsed
        writeTeamPanelCollapsed(next)
        return { teamPanelCollapsed: next }
      }),
    setLocale: (l) => {
      writeLocale(l)
      set({ locale: l })
    },
    setTheme: (t) => {
      writeTheme(t)
      applyThemeClass(t)
      set({ theme: t })
    },
    setAccent: (a) => {
      writeAccent(a)
      applyAccentAttr(a)
      set({ accent: a })
    },
    setDefaultModel: (m) => {
      writeDefaultModel(m)
      set({ defaultModel: m })
    },

    addCompany: (company) => {
      set((s) => ({
        companies: [...s.companies, company],
        currentCompanyId: company.id,
        currentTeamId: company.teams[0]?.id ?? s.currentTeamId,
      }))
      void saveCompany(company).catch((e) => console.error('saveCompany failed', e))
    },

    addTeam: (companyId, team) => {
      const company = get().companies.find((c) => c.id === companyId)
      set((s) => ({
        companies: s.companies.map((c) =>
          c.id === companyId ? { ...c, teams: [...c.teams, team] } : c,
        ),
        currentCompanyId: companyId,
        currentTeamId: team.id,
      }))
      if (company) {
        void saveTeam(company.slug, team).catch((e) => console.error('saveTeam failed', e))
      }
    },

    updateTeam: (companyId, team) => {
      const company = get().companies.find((c) => c.id === companyId)
      set((s) => ({
        companies: s.companies.map((c) =>
          c.id === companyId
            ? { ...c, teams: c.teams.map((t) => (t.id === team.id ? team : t)) }
            : c,
        ),
      }))
      if (company) {
        void saveTeam(company.slug, team).catch((e) => console.error('saveTeam failed', e))
      }
    },

    hydrate: async () => {
      // Allow re-hydration after onboarding saves a fresh company.
      try {
        const fromServer = await fetchCompanies()
        if (fromServer.length > 0) {
          const initial = pickInitial(fromServer)
          set({ companies: fromServer, hydrated: true, ...initial })
        } else {
          // Empty server — stay empty. The /onboarding route handles first-session.
          set({ companies: [], currentCompanyId: '', currentTeamId: '', hydrated: true })
        }
      } catch (e) {
        console.error('hydrate failed', e)
        set({ hydrated: true })
      }
    },
  }
})

export function useCurrentTeam() {
  return useAppStore((s) => {
    const company = s.companies.find((c) => c.id === s.currentCompanyId)
    return company?.teams.find((t) => t.id === s.currentTeamId)
  })
}
