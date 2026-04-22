import { PaperPlaneRight, Warning } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AskUserModal } from '@/components/modals/AskUserModal'
import { type AskUserQuestion, type SessionEvent, postAnswer, streamSession } from '@/lib/api/sessions'
import { useT } from '@/lib/i18n'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import type { Message } from '@/lib/types'

interface PendingAsk {
  toolCallId: string
  questions: AskUserQuestion[]
  agentRole?: string
}

function makeId() {
  return `m-${Math.random().toString(36).slice(2, 9)}`
}

const SUPPORTED_PROVIDERS = new Set(['copilot', 'claude-code', 'codex'])

export function ChatTab() {
  const t = useT()
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const team = useCurrentTeam()
  const messages = useDrawerStore((s) => s.messages)
  const addMessage = useDrawerStore((s) => s.addMessage)
  const updateMessage = useDrawerStore((s) => s.updateMessage)
  const commitMessage = useDrawerStore((s) => s.commitMessage)
  const loadTeamMessages = useDrawerStore((s) => s.loadTeamMessages)
  const setActiveAgents = useCanvasStore((s) => s.setActiveAgents)
  const setActiveEdges = useCanvasStore((s) => s.setActiveEdges)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null)
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

  useEffect(() => {
    if (currentTeamId) void loadTeamMessages(currentTeamId)
  }, [currentTeamId, loadTeamMessages])

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
      setError(t('chat.unsupportedProviders', { roles: unsupported.join(', ') }))
      return
    }

    // Per-node bubble ids — when events for a node arrive, we append/update its bubble.
    const bubbleByNode: Record<string, string> = {}
    const outputByNode: Record<string, string> = {}
    // Track every bubble id opened so we can persist them on session end.
    const allBubbleIds: string[] = []
    // Active-sets tracked locally so we can grow/shrink them as events arrive.
    const activeNodes = new Set<string>()
    const activeEdges = new Set<string>()

    setBusy(true)
    try {
      const iter = streamSession(team, text)
      for (;;) {
        const step = await iter.next()
        if (step.done) break
        const ev: SessionEvent = step.value
        handleEvent(ev, { team, bubbleByNode, outputByNode, addMessage, updateMessage, setActiveAgents, setActiveEdges, currentTeamId, scrollRef, setPendingAsk, allBubbleIds, activeNodes, activeEdges })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActiveAgents([])
      setActiveEdges([])
      setBusy(false)
      // Persist every per-node bubble opened during this session.
      for (const id of allBubbleIds) {
        commitMessage(id)
      }
    }
  }

  const submitAnswers = async (answers: Record<string, string>) => {
    if (!pendingAsk) return
    try {
      await postAnswer(pendingAsk.toolCallId, { answers })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPendingAsk(null)
    }
  }

  const skipAsk = async () => {
    if (!pendingAsk) return
    try {
      await postAnswer(pendingAsk.toolCallId, { skipped: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPendingAsk(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-neutral-200 bg-white">
        <div className="text-[15px] text-neutral-500">
          <span className="font-medium text-neutral-700">{team?.name ?? 'team'}</span> ·{' '}
          {team?.agents.length ?? 0} agents · lead{' '}
          <span className="font-medium text-neutral-700">{leadLabel}</span>
          {lead && (
            <>
              {' '}
              <span className="font-mono text-[14px] text-neutral-500">
                ({lead.label} / {lead.model})
              </span>
            </>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {teamMessages.length === 0 && (
          <div className="text-[15px] text-neutral-400 text-center py-10">{t('chat.empty')}</div>
        )}
        {teamMessages.map((m) => {
          const fromAgent = team?.agents.find((a) => a.id === m.from)
          const isUser = m.from === 'user'
          const isSystemNote = m.from === 'system'
          if (isSystemNote) {
            return (
              <div key={m.id} className="text-[14px] text-neutral-400 text-center font-mono">
                {m.text}
              </div>
            )
          }
          return (
            <div key={m.id} className={isUser ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  isUser
                    ? 'max-w-[80%] rounded-md rounded-br-md bg-neutral-900 text-white px-3 py-2 text-[15px]'
                    : 'max-w-[85%] rounded-md rounded-bl-md bg-neutral-100 text-neutral-900 px-3 py-2 text-[15px]'
                }
              >
                {!isUser && (
                  <div className="text-[14px] font-medium text-neutral-500 mb-0.5">
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
        <div className="mx-3 mb-2 flex items-start gap-2 rounded bg-red-50 border border-red-200 text-red-700 text-[15px] px-2.5 py-2">
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
            placeholder={t('chat.messagePlaceholder', { lead: leadLabel })}
            disabled={busy}
            className="flex-1 resize-none px-3 py-2 text-[15px] rounded border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300 max-h-32 disabled:bg-neutral-50"
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim() || busy}
            aria-label={t('chat.send')}
            className="w-9 h-9 rounded bg-neutral-900 text-white flex items-center justify-center hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <PaperPlaneRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <AskUserModal
        open={!!pendingAsk}
        questions={pendingAsk?.questions ?? []}
        agentRole={pendingAsk?.agentRole}
        onSubmit={submitAnswers}
        onSkip={skipAsk}
      />
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
  setActiveEdges: (ids: string[]) => void
  currentTeamId: string
  scrollRef: React.RefObject<HTMLDivElement | null>
  setPendingAsk: (p: PendingAsk | null) => void
  allBubbleIds: string[]
  activeNodes: Set<string>
  activeEdges: Set<string>
}

function handleEvent(ev: SessionEvent, ctx: HandleCtx) {
  const { team, bubbleByNode, outputByNode, addMessage, updateMessage, setActiveAgents, setActiveEdges, currentTeamId, scrollRef, setPendingAsk, allBubbleIds, activeNodes, activeEdges } = ctx

  switch (ev.kind) {
    case 'node_started': {
      if (!ev.node_id) return
      // Don't create a bubble yet — wait for the first token so nodes that go
      // straight to delegation (emit 0 text) don't leave empty bubbles behind.
      activeNodes.add(ev.node_id)
      setActiveAgents(Array.from(activeNodes))
      return
    }
    case 'node_finished': {
      if (!ev.node_id) return
      activeNodes.delete(ev.node_id)
      setActiveAgents(Array.from(activeNodes))
      return
    }
    case 'token': {
      if (!ev.node_id) return
      let bubbleId = bubbleByNode[ev.node_id]
      if (!bubbleId) {
        // Token arriving without an active bubble (e.g. Lead resumes after a
        // tool_result that closed the previous turn) — open a new one appended
        // at the chronological end.
        bubbleId = makeId()
        bubbleByNode[ev.node_id] = bubbleId
        outputByNode[ev.node_id] = ''
        allBubbleIds.push(bubbleId)
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
      const assigneeId = String(ev.data.assignee_id ?? '')
      const assigneeRole = String(ev.data.assignee_role ?? '')
      const task = String(ev.data.task ?? '')
      if (ev.node_id && assigneeId) {
        // Light every org-chart edge from parent to the assignee(s).
        for (const e of team.edges) {
          if (e.source === ev.node_id && e.target === assigneeId) {
            activeEdges.add(e.id)
          }
        }
        setActiveEdges(Array.from(activeEdges))
      }
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
      const assigneeId = String(ev.data.assignee_id ?? '')
      const assigneeRole = String(ev.data.assignee_role ?? '')
      const isError = Boolean(ev.data.error)
      if (ev.node_id && assigneeId) {
        for (const e of team.edges) {
          if (e.source === ev.node_id && e.target === assigneeId) {
            activeEdges.delete(e.id)
          }
        }
        setActiveEdges(Array.from(activeEdges))
      }
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
    case 'user_question': {
      const qs = (ev.data.questions as AskUserQuestion[]) ?? []
      const agentRole = String(ev.data.agent_role ?? '') || undefined
      if (ev.tool_call_id && qs.length > 0) {
        setPendingAsk({ toolCallId: ev.tool_call_id, questions: qs, agentRole })
        addMessage({
          id: makeId(),
          teamId: currentTeamId,
          from: 'system',
          text: `❓ ${agentRole ?? 'agent'} is asking ${qs.length} question${qs.length > 1 ? 's' : ''}…`,
          createdAt: new Date().toISOString(),
        })
      }
      return
    }
    case 'user_answered': {
      setPendingAsk(null)
      const skipped = Boolean(ev.data.skipped)
      addMessage({
        id: makeId(),
        teamId: currentTeamId,
        from: 'system',
        text: skipped ? '↳ skipped' : '↳ answered',
        createdAt: new Date().toISOString(),
      })
      return
    }
    case 'run_error': {
      addMessage({
        id: makeId(),
        teamId: currentTeamId,
        from: 'system',
        text: `⚠ ${String(ev.data.error ?? 'session failed')}`,
        createdAt: new Date().toISOString(),
      })
      return
    }
    default:
      return
  }
}
