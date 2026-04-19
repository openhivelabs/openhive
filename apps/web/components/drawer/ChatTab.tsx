'use client'

import { PaperPlaneRight, Warning } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { streamChat } from '@/lib/api/chat'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import type { Message } from '@/lib/types'

function makeId() {
  return `m-${Math.random().toString(36).slice(2, 9)}`
}

const STREAMING_PROVIDERS = new Set(['copilot'])

export function ChatTab() {
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const team = useCurrentTeam()
  const { messages, addMessage, updateMessage } = useDrawerStore()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const teamMessages = useMemo(
    () => messages.filter((m) => m.teamId === currentTeamId),
    [messages, currentTeamId],
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    // Auto-scroll on any new delta
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [])

  const lead = team?.agents[0]
  const leadLabel = lead?.role ?? 'Lead'
  const providerSupported = lead ? STREAMING_PROVIDERS.has(lead.providerId) : false

  const send = async () => {
    if (!lead) return
    const text = input.trim()
    if (!text || busy) return
    setError(null)

    const userMsg: Message = {
      id: makeId(),
      teamId: currentTeamId,
      from: 'user',
      text,
      createdAt: new Date().toISOString(),
    }
    addMessage(userMsg)
    setInput('')

    if (!providerSupported) {
      setError(
        `Provider "${lead.providerId}" isn't wired for streaming yet. Use Copilot (gpt-5-mini) for now.`,
      )
      return
    }

    // History: all prior messages of the team translated into OpenAI-style chat.
    const history = teamMessages.map((m) => ({
      role: m.from === 'user' ? ('user' as const) : ('assistant' as const),
      content: m.text,
    }))
    history.push({ role: 'user', content: text })

    const replyId = makeId()
    addMessage({
      id: replyId,
      teamId: currentTeamId,
      from: lead.id,
      text: '',
      createdAt: new Date().toISOString(),
    })

    setBusy(true)
    try {
      const iter = streamChat({
        provider: lead.providerId,
        model: lead.model,
        system: lead.systemPrompt || undefined,
        messages: history,
      })
      let acc = ''
      for (;;) {
        const step = await iter.next()
        if (step.done) break
        acc += step.value
        updateMessage(replyId, { text: acc })
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
      }
      if (!acc) {
        updateMessage(replyId, { text: '(empty response)' })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      updateMessage(replyId, { text: `⚠ ${msg}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-neutral-200 bg-white">
        <div className="text-xs text-neutral-500">
          Messages to <span className="font-medium text-neutral-700">{team?.name ?? 'team'}</span>{' '}
          go to <span className="font-medium text-neutral-700">{leadLabel}</span>
          {lead && (
            <>
              {' · '}
              <span className="font-mono text-[11px] text-neutral-500">
                {lead.label} / {lead.model}
              </span>
            </>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {teamMessages.length === 0 && (
          <div className="text-sm text-neutral-400 text-center py-10">
            No messages yet. Start by typing below.
          </div>
        )}
        {teamMessages.map((m) => {
          const fromAgent = team?.agents.find((a) => a.id === m.from)
          const isUser = m.from === 'user'
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
