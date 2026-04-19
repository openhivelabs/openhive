'use client'

import { PaperPlaneRight } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import type { Message } from '@/lib/types'

function makeId() {
  return `m-${Math.random().toString(36).slice(2, 9)}`
}

export function ChatTab() {
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const team = useCurrentTeam()
  const { messages, addMessage } = useDrawerStore()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const teamMessages = useMemo(
    () => messages.filter((m) => m.teamId === currentTeamId),
    [messages, currentTeamId],
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  const leadId = team?.agents[0]?.id
  const leadLabel = team?.agents[0]?.role ?? 'Lead'

  const send = () => {
    const text = input.trim()
    if (!text) return
    const userMsg: Message = {
      id: makeId(),
      teamId: currentTeamId,
      from: 'user',
      text,
      createdAt: new Date().toISOString(),
    }
    addMessage(userMsg)
    setInput('')

    // Canned agent reply after 800ms
    setTimeout(() => {
      addMessage({
        id: makeId(),
        teamId: currentTeamId,
        from: leadId ?? 'agent',
        text: `Understood — I'll coordinate the team on: "${text}". Stand by for a draft plan.`,
        createdAt: new Date().toISOString(),
      })
    }, 800)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-neutral-200 bg-white">
        <div className="text-xs text-neutral-500">
          Messages to <span className="font-medium text-neutral-700">{team?.name ?? 'team'}</span>{' '}
          go to <span className="font-medium text-neutral-700">{leadLabel}</span> by default.
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
            <div
              key={m.id}
              className={isUser ? 'flex justify-end' : 'flex justify-start'}
            >
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
                <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>
              </div>
            </div>
          )
        })}
      </div>

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
            className="flex-1 resize-none px-3 py-2 text-sm rounded-lg border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300 max-h-32"
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim()}
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
