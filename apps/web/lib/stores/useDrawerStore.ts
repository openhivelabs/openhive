import { create } from 'zustand'
import { mockArtifacts } from '../mock/artifacts'
import { mockMessages } from '../mock/messages'
import { mockTriggers } from '../mock/triggers'
import type { Artifact, DrawerTab, Message, Trigger } from '../types'

interface DrawerState {
  tab: DrawerTab
  selectedAgentId: string | null
  messages: Message[]
  triggers: Trigger[]
  artifacts: Artifact[]

  setTab: (tab: DrawerTab) => void
  setSelectedAgent: (id: string | null) => void
  addMessage: (m: Message) => void
  addTrigger: (t: Trigger) => void
  removeTrigger: (id: string) => void
  toggleTrigger: (id: string) => void
}

export const useDrawerStore = create<DrawerState>((set) => ({
  tab: 'chat',
  selectedAgentId: null,
  messages: mockMessages,
  triggers: mockTriggers,
  artifacts: mockArtifacts,

  setTab: (tab) => set({ tab }),
  setSelectedAgent: (id) => set({ selectedAgentId: id }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  addTrigger: (t) => set((s) => ({ triggers: [...s.triggers, t] })),
  removeTrigger: (id) => set((s) => ({ triggers: s.triggers.filter((t) => t.id !== id) })),
  toggleTrigger: (id) =>
    set((s) => ({
      triggers: s.triggers.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)),
    })),
}))
