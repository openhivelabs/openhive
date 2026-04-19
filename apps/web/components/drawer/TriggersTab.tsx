'use client'

import { clsx } from 'clsx'
import {
  Clock,
  FolderOpen,
  MessagesSquare,
  MousePointer,
  Plus,
  Trash2,
  Webhook,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppStore } from '@/lib/stores/useAppStore'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import type { Trigger, TriggerKind } from '@/lib/types'
import { Button } from '../ui/Button'

const KIND_META: Record<TriggerKind, { icon: typeof Clock; label: string }> = {
  chat: { icon: MessagesSquare, label: 'Chat' },
  cron: { icon: Clock, label: 'Cron' },
  webhook: { icon: Webhook, label: 'Webhook' },
  file_watch: { icon: FolderOpen, label: 'File watch' },
  manual: { icon: MousePointer, label: 'Manual' },
}

function makeId() {
  return `tr-${Math.random().toString(36).slice(2, 9)}`
}

export function TriggersTab() {
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const { triggers, addTrigger, removeTrigger, toggleTrigger } = useDrawerStore()
  const [showForm, setShowForm] = useState(false)
  const [formKind, setFormKind] = useState<TriggerKind>('cron')
  const [formLabel, setFormLabel] = useState('')
  const [formConfig, setFormConfig] = useState('0 9 * * MON')

  const teamTriggers = useMemo(
    () => triggers.filter((t) => t.teamId === currentTeamId),
    [triggers, currentTeamId],
  )

  const save = () => {
    if (!formLabel.trim()) return
    const configField =
      formKind === 'cron'
        ? { schedule: formConfig }
        : formKind === 'webhook'
          ? { path: formConfig }
          : formKind === 'file_watch'
            ? { directory: formConfig }
            : { value: formConfig }
    const t: Trigger = {
      id: makeId(),
      kind: formKind,
      teamId: currentTeamId,
      label: formLabel,
      config: configField,
      enabled: true,
    }
    addTrigger(t)
    setShowForm(false)
    setFormLabel('')
    setFormConfig('')
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-neutral-200 flex items-center justify-between">
        <span className="text-xs text-neutral-500">
          {teamTriggers.length} trigger{teamTriggers.length === 1 ? '' : 's'}
        </span>
        <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)}>
          <Plus className="w-3.5 h-3.5" />
          Add
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {showForm && (
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 space-y-2">
            <div className="text-xs font-medium text-neutral-500">New trigger</div>
            <select
              value={formKind}
              onChange={(e) => setFormKind(e.target.value as TriggerKind)}
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-neutral-300 bg-white"
            >
              {(Object.entries(KIND_META) as [TriggerKind, (typeof KIND_META)[TriggerKind]][]).map(
                ([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ),
              )}
            </select>
            <input
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder="Label (e.g. Weekly market report)"
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-neutral-300 bg-white"
            />
            <input
              value={formConfig}
              onChange={(e) => setFormConfig(e.target.value)}
              placeholder={
                formKind === 'cron'
                  ? '0 9 * * MON'
                  : formKind === 'webhook'
                    ? '/webhook/...'
                    : formKind === 'file_watch'
                      ? '~/inbox'
                      : 'value'
              }
              className="w-full px-2.5 py-1.5 text-sm font-mono rounded-md border border-neutral-300 bg-white"
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={save}>
                Save
              </Button>
            </div>
          </div>
        )}

        {teamTriggers.length === 0 && !showForm && (
          <div className="text-sm text-neutral-400 text-center py-10">
            No triggers for this team yet.
          </div>
        )}

        {teamTriggers.map((t) => {
          const Icon = KIND_META[t.kind].icon
          const label = KIND_META[t.kind].label
          const configStr = Object.entries(t.config)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(' · ')
          return (
            <div
              key={t.id}
              className={clsx(
                'rounded-xl border bg-white px-3 py-2.5 flex items-start gap-2.5',
                t.enabled ? 'border-neutral-200' : 'border-neutral-200 opacity-60',
              )}
            >
              <div className="mt-0.5 w-7 h-7 rounded-md bg-neutral-100 flex items-center justify-center">
                <Icon className="w-3.5 h-3.5 text-neutral-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-900 truncate">{t.label}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                    {label}
                  </span>
                </div>
                <div className="text-xs text-neutral-500 font-mono truncate mt-0.5">
                  {configStr}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggleTrigger(t.id)}
                  className={clsx(
                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                    t.enabled ? 'bg-emerald-500' : 'bg-neutral-300',
                  )}
                  aria-label={t.enabled ? 'Disable' : 'Enable'}
                >
                  <span
                    className={clsx(
                      'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                      t.enabled ? 'translate-x-4' : 'translate-x-0.5',
                    )}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => removeTrigger(t.id)}
                  aria-label="Remove trigger"
                  className="p-1 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

