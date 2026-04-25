import { create } from 'zustand'
import { fetchArtifactsForTeam } from '../api/artifacts'
import { appendMessage, clearMessages, listMessages } from '../api/messages'
import type { Artifact, DrawerTab, Message, Trigger } from '../types'

interface DrawerState {
  tab: DrawerTab
  selectedAgentId: string | null
  messages: Message[]
  triggers: Trigger[]
  artifacts: Artifact[]
  loadedTeamIds: Set<string>
  artifactsLoadedFor: Set<string>

  setTab: (tab: DrawerTab) => void
  setSelectedAgent: (id: string | null) => void
  /** Append (local + POST). Use for user messages and final agent bubbles. */
  addMessage: (m: Message) => void
  /** Local-only update — for streaming tokens that shouldn't hit the server yet. */
  updateMessage: (id: string, patch: Partial<Message>) => void
  /** Write a message's current state to the server — call after streaming finishes. */
  commitMessage: (id: string) => void
  /** Load persisted messages for a team into the store (once per team). */
  loadTeamMessages: (teamId: string) => Promise<void>
  clearTeamMessages: (teamId: string) => Promise<void>

  /** Fetch artifacts produced by skills for this team. Idempotent per teamId. */
  loadTeamArtifacts: (teamId: string) => Promise<void>
  /** Force refetch — call after a session finishes to pick up newly produced files. */
  refreshTeamArtifacts: (teamId: string) => Promise<void>

  addTrigger: (t: Trigger) => void
  removeTrigger: (id: string) => void
  toggleTrigger: (id: string) => void
}

export const useDrawerStore = create<DrawerState>((set, get) => ({
  tab: 'chat',
  selectedAgentId: null,
  messages: [],
  triggers: [],
  artifacts: [],
  loadedTeamIds: new Set<string>(),
  artifactsLoadedFor: new Set<string>(),

  setTab: (tab) => set({ tab }),
  setSelectedAgent: (id) => set({ selectedAgentId: id }),

  addMessage: (m) => {
    set((s) => ({ messages: [...s.messages, m] }))
    void appendMessage(m).catch((e) => console.error('appendMessage failed', e))
  },

  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),

  commitMessage: (id) => {
    const msg = get().messages.find((m) => m.id === id)
    if (!msg) return
    void appendMessage(msg).catch((e) => console.error('commitMessage failed', e))
  },

  loadTeamMessages: async (teamId) => {
    if (get().loadedTeamIds.has(teamId)) return
    try {
      const persisted = await listMessages(teamId)
      set((s) => {
        // Dedupe by id — keep local in-progress bubbles over server copies.
        const byId = new Map<string, Message>()
        for (const m of persisted) byId.set(m.id, m)
        for (const m of s.messages) byId.set(m.id, m)
        const merged = Array.from(byId.values()).sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
        )
        const nextLoaded = new Set(s.loadedTeamIds)
        nextLoaded.add(teamId)
        return { messages: merged, loadedTeamIds: nextLoaded }
      })
    } catch (e) {
      console.error('loadTeamMessages failed', e)
    }
  },

  loadTeamArtifacts: async (teamId) => {
    if (get().artifactsLoadedFor.has(teamId)) return
    await get().refreshTeamArtifacts(teamId)
  },

  refreshTeamArtifacts: async (teamId) => {
    try {
      const fresh = await fetchArtifactsForTeam(teamId)
      set((s) => {
        // Replace this team's artifacts; keep other teams' rows untouched.
        const others = s.artifacts.filter((a) => a.teamId !== teamId)
        const next = new Set(s.artifactsLoadedFor)
        next.add(teamId)
        return { artifacts: [...others, ...fresh], artifactsLoadedFor: next }
      })
    } catch (e) {
      console.error('loadTeamArtifacts failed', e)
    }
  },

  clearTeamMessages: async (teamId) => {
    await clearMessages(teamId)
    set((s) => ({
      messages: s.messages.filter((m) => m.teamId !== teamId),
    }))
  },

  addTrigger: (t) => set((s) => ({ triggers: [...s.triggers, t] })),
  removeTrigger: (id) => set((s) => ({ triggers: s.triggers.filter((t) => t.id !== id) })),
  toggleTrigger: (id) =>
    set((s) => ({
      triggers: s.triggers.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)),
    })),
}))
