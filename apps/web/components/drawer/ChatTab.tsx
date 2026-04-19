'use client'

import { PaperPlaneRight, Warning } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type RunEvent, streamRun } from '@/lib/api/runs'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import type { Message } from '@/lib/types'

function makeId() {
  return `m-${Math.random().toString(36).slice(2, 9)}`
}

const SUPPORTED_PROVIDERS = new Set(['copilot'])

export function ChatTab() {
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const team = useCurrentTeam()
  const { messages, addMessage, updateMessage } = useDrawerStore()
  const setActiveAgents = useCanvasStore((s) => s.setActiveAgents)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const teamMessages = useMemo(
    () => messages.filter((m) => m.teamId === currentTeamId),
    [messages, currentTeamId],
  )

  const lead = team?.agents[0]
  const leadLabel = lead?.role ?? 'Lead'
  // If any agent in the team uses an unsupported provider, warn up front.
  const unsupported = useMemo(() => {
    if (!team) return []
    return team.agents.filter((a) => !SUPPORTED_PROVIDERS.has(a.providerId)).map((a) => a.role)
  }, [team])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [])

  const send = async () => {
    if (!team || !lead) return
    const text = input.trim()
    if (!text || busy) return
    setError(null)

    // User message
    const userMsg: Message = {
      id: makeId(),
      teamId: currentTeamId,
      from: 'user',
      text,
      createdAt: new Date().toISOString(),
    }
    addMessage(userMsg)
    setInput('')

    if (unsupported.length > 0) {
      setError(
        `Some agents use a provider not yet wired for runs (${unsupported.join(', ')}). Switch them to Copilot for now.`,
      )
      return
    }

    // Per-node bubble ids — when events for a node arrive, we append/update its bubble.
    const bubbleByNode: Record<string, string> = {}
    const outputByNode: Record<string, string> = {}

    setBusy(true)
    try {
      const iter = streamRun(team, text)
      for (;;) {
        const step = await iter.next()
        if (step.done) break
        const ev: RunEvent = step.value
        handleEvent(ev, { team, bubbleByNode, outputByNode, addMessage, updateMessage, setActiveAgents, currentTeamId, scrollRef })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActiveAgents([])
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-neutral-200 bg-white">
        <div className="text-xs text-neutral-500">
          <span className="font-medium text-neutral-700">{team?.name ?? 'team'}</span> ·{' '}
          {team?.agents.length ?? 0} agents · lead{' '}
          <span className="font-medium text-neutral-700">{leadLabel}</span>
          {lead && (
            <>
              {' '}
              <span className="font-mono text-[11px] text-neutral-500">
                ({lead.label} / {lead.model})
              </span>
            </>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {teamMessages.length === 0 && (
          <div className="text-sm text-neutral-400 text-center py-10">
            No messages yet. Send a goal — the lead will delegate as needed.
          </div>
        )}
        {teamMessages.map((m) => {
          const fromAgent = team?.agents.find((a) => a.id === m.from)
          const isUser = m.from === 'user'
          const isSystemNote = m.from === 'system'
          if (isSystemNote) {
            return (
              <div key={m.id} className="text-[11px] text-neutral-400 text-center font-mono">
                {m.text}
              </div>
            )
          }
          return (
            <div key={m.id} className={isUser ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  isUser
                    ? 'max-w-[80%] rounded-2xl rounded-br-md bg-neutral-900 text-white px-3 py-2 text-sm'
                    : 'max-w-[85%] rounded-2xl rounded-bl-md bg-neutral-100 text-neutral-900 px-3 py-2 text-sm'
                }
              >
                {!isUser && (
                  <div className="text-[11px] font-medium text-neutral-500 mb-0.5">
                    {fromAgent?.role ?? 'Agent'}
                  </div>
                )}
                <div className="whitespace-pre-wrap leading-relaxed">
                  {m.text || <span className="text-neutral-400">▍</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {error && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-2.5 py-2">
          <Warning className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      <div className="border-t border-neutral-200 p-3 bg-white">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={1}
            placeholder={`Message ${leadLabel}…`}
            disabled={busy}
            className="flex-1 resize-none px-3 py-2 text-sm rounded-lg border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300 max-h-32 disabled:bg-neutral-50"
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim() || busy}
            aria-label="Send"
            className="w-9 h-9 rounded-lg bg-neutral-900 text-white flex items-center justify-center hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <PaperPlaneRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

interface HandleCtx {
  team: import('@/lib/types').Team
  bubbleByNode: Record<string, string>
  outputByNode: Record<string, string>
  addMessage: (m: Message) => void
  updateMessage: (id: string, patch: Partial<Message>) => void
  setActiveAgents: (ids: string[]) => void
  currentTeamId: string
  scrollRef: React.RefObject<HTMLDivElement | null>
}

function handleEvent(ev: RunEvent, ctx: HandleCtx) {
  const { team, bubbleByNode, outputByNode, addMessage, updateMessage, setActiveAgents, currentTeamId, scrollRef } = ctx

  switch (ev.kind) {
    case 'node_started': {
      if (!ev.node_id) return
      // Don't create a bubble yet — wait for the first token so nodes that go
      // straight to delegation (emit 0 text) don't leave empty bubbles behind.
      setActiveAgents([ev.node_id])
      return
    }
    case 'token': {
      if (!ev.node_id) return
      let bubbleId = bubbleByNode[ev.node_id]
      if (!bubbleId) {
        // Token arriving without an active bubble (e.g. CEO resumes after a
        // tool_result that closed the previous turn) — open a new one appended
        // at the chronological end.
        bubbleId = makeId()
        bubbleByNode[ev.node_id] = bubbleId
        outputByNode[ev.node_id] = ''
        addMessage({
          id: bubbleId,
          teamId: currentTeamId,
          from: ev.node_id,
          text: '',
          createdAt: new Date().toISOString(),
        })
      }
      const delta = String(ev.data.text ?? '')
      outputByNode[ev.node_id] = (outputByNode[ev.node_id] ?? '') + delta
      updateMessage(bubbleId, { text: outputByNode[ev.node_id] })
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
      return
    }
    case 'tool_result': {
      // Close this node's current bubble so the next token opens a fresh one
      // below the tool trace — keeps chronology linear in the chat log.
      if (ev.node_id) {
        delete bubbleByNode[ev.node_id]
      }
      return
    }
    case 'delegation_opened': {
      const assigneeRole = String(ev.data.assignee_role ?? '')
      const task = String(ev.data.task ?? '')
      addMessage({
        id: makeId(),
        teamId: currentTeamId,
        from: 'system',
        text: `↘ delegating to ${assigneeRole}: ${task}`,
        createdAt: new Date().toISOString(),
      })
      return
    }
    case 'delegation_closed': {
      const assigneeRole = String(ev.data.assignee_role ?? '')
      const isError = Boolean(ev.data.error)
      addMessage({
        id: makeId(),
        teamId: currentTeamId,
        from: 'system',
        text: isError
          ? `⚠ delegation to ${assigneeRole} failed`
          : `↙ ${assigneeRole} reported back`,
        createdAt: new Date().toISOString(),
      })
      return
    }
    case 'tool_called': {
      // Only interesting for non-delegate tools in the future (skills / mcp).
      if (ev.tool_name && ev.tool_name !== 'delegate_to') {
        addMessage({
          id: makeId(),
          teamId: currentTeamId,
          from: 'system',
          text: `• tool ${ev.tool_name}`,
          createdAt: new Date().toISOString(),
        })
      }
      return
    }
    case 'run_error': {
      addMessage({
        id: makeId(),
        teamId: currentTeamId,
        from: 'system',
        text: `⚠ ${String(ev.data.error ?? 'run failed')}`,
        createdAt: new Date().toISOString(),
      })
      return
    }
    default:
      return
  }
}
