'use client'

import { CircleNotch, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { type ModelInfo, listModels } from '@/lib/api/models'
import { mockProviders } from '@/lib/mock/companies'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import type { Agent } from '@/lib/types'
import { Button } from '../ui/Button'

interface NodeEditorProps {
  agent: Agent | null
  onClose: () => void
}

// Simple in-memory cache so switching providers in the dropdown feels instant on retry.
const modelCache: Record<string, ModelInfo[]> = {}

export function NodeEditor({ agent, onClose }: NodeEditorProps) {
  const updateAgent = useCanvasStore((s) => s.updateAgent)
  const removeAgent = useCanvasStore((s) => s.removeAgent)

  const [draft, setDraft] = useState<Agent | null>(agent)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(agent)
  }, [agent])

  useEffect(() => {
    if (!draft) return
    const providerId = draft.providerId
    const cached = modelCache[providerId]
    if (cached) {
      setModels(cached)
      setModelsError(null)
      return
    }
    setLoadingModels(true)
    setModelsError(null)
    listModels(providerId)
      .then((list) => {
        modelCache[providerId] = list
        setModels(list)
        // If the current model isn't offered by the newly-selected provider, snap to its default.
        setDraft((prev) => {
          if (!prev || prev.providerId !== providerId) return prev
          if (list.some((m) => m.id === prev.model)) return prev
          const fallback = list.find((m) => m.default)?.id ?? list[0]?.id
          return fallback ? { ...prev, model: fallback } : prev
        })
      })
      .catch((e) => setModelsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingModels(false))
  }, [draft?.providerId])

  if (!agent || !draft) return null

  const onChangeProvider = (providerId: string) => {
    const provider = mockProviders.find((p) => p.id === providerId)
    // When provider changes, reset model to the provider's default (or first of list)
    const cached = modelCache[providerId]
    const nextModel = cached?.find((m) => m.default)?.id ?? cached?.[0]?.id ?? draft.model
    setDraft({
      ...draft,
      providerId,
      label: provider?.label ?? draft.label,
      model: nextModel,
    })
  }

  const save = () => {
    const provider = mockProviders.find((p) => p.id === draft.providerId)
    updateAgent(agent.id, {
      role: draft.role,
      providerId: draft.providerId,
      label: provider?.label ?? draft.label,
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
                onChange={(e) => onChangeProvider(e.target.value)}
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
              {loadingModels ? (
                <div className="input flex items-center gap-2 text-neutral-500">
                  <CircleNotch className="w-3.5 h-3.5 animate-spin" />
                  Loading…
                </div>
              ) : modelsError ? (
                <input
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  className="input"
                  placeholder="model id"
                />
              ) : (
                <select
                  value={models.some((m) => m.id === draft.model) ? draft.model : ''}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  className="input"
                >
                  {!models.some((m) => m.id === draft.model) && draft.model && (
                    <option value="">{draft.model} (not in list)</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.default ? ' · default' : ''}
                    </option>
                  ))}
                </select>
              )}
              {modelsError && (
                <div className="mt-1 text-[11px] text-amber-700">
                  Couldn't load models ({modelsError}). Type a model id manually.
                </div>
              )}
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
