'use client'

import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { mockProviders } from '@/lib/mock/companies'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import type { Agent } from '@/lib/types'
import { Button } from '../ui/Button'

interface NodeEditorProps {
  agent: Agent | null
  onClose: () => void
}

export function NodeEditor({ agent, onClose }: NodeEditorProps) {
  const updateAgent = useCanvasStore((s) => s.updateAgent)
  const removeAgent = useCanvasStore((s) => s.removeAgent)

  const [draft, setDraft] = useState<Agent | null>(agent)

  useEffect(() => {
    setDraft(agent)
  }, [agent])

  if (!agent || !draft) return null

  const save = () => {
    updateAgent(agent.id, {
      role: draft.role,
      providerId: draft.providerId,
      label: mockProviders.find((p) => p.id === draft.providerId)?.label ?? draft.label,
      model: draft.model,
      systemPrompt: draft.systemPrompt,
    })
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit agent"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-2xl bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold">Edit agent</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <Field label="Role">
            <input
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
              className="input"
              placeholder="e.g. CEO, Researcher, Writer"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider">
              <select
                value={draft.providerId}
                onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}
                className="input"
              >
                {mockProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <input
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                className="input"
                placeholder="claude-opus-4-5"
              />
            </Field>
          </div>

          <Field label="System prompt">
            <textarea
              value={draft.systemPrompt}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              rows={5}
              className="input font-mono text-xs"
            />
          </Field>
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-neutral-200 bg-neutral-50 rounded-b-2xl">
          <Button
            variant="ghost"
            onClick={() => {
              removeAgent(agent.id)
              onClose()
            }}
            className="!text-red-600 hover:!bg-red-50"
          >
            Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          </div>
        </div>

        <style jsx>{`
          .input {
            width: 100%;
            padding: 0.5rem 0.75rem;
            font-size: 0.875rem;
            border-radius: 0.5rem;
            border: 1px solid #d4d4d4;
            background: white;
            outline: none;
          }
          .input:focus {
            border-color: #737373;
            box-shadow: 0 0 0 3px rgb(115 115 115 / 0.1);
          }
        `}</style>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-neutral-500 mb-1">{label}</span>
      {children}
    </label>
  )
}
