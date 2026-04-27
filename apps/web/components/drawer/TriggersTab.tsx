import { clsx } from 'clsx'
import {
  ChatCircleText,
  Clock,
  CursorClick,
  FolderOpen,
  Plus,
  Trash,
  PlugsConnected,
} from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import type { Trigger, TriggerKind } from '@/lib/types'
import { Button } from '../ui/Button'

const KIND_META: Record<TriggerKind, { icon: typeof Clock; labelKey: string }> = {
  chat: { icon: ChatCircleText, labelKey: 'triggers.kind.chat' },
  cron: { icon: Clock, labelKey: 'triggers.kind.cron' },
  webhook: { icon: PlugsConnected, labelKey: 'triggers.kind.webhook' },
  file_watch: { icon: FolderOpen, labelKey: 'triggers.kind.fileWatch' },
  manual: { icon: CursorClick, labelKey: 'triggers.kind.manual' },
}

function makeId() {
  return `tr-${Math.random().toString(36).slice(2, 9)}`
}

export function TriggersTab() {
  const t = useT()
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const triggers = useDrawerStore((s) => s.triggers)
  const addTrigger = useDrawerStore((s) => s.addTrigger)
  const removeTrigger = useDrawerStore((s) => s.removeTrigger)
  const toggleTrigger = useDrawerStore((s) => s.toggleTrigger)
  const [showForm, setShowForm] = useState(false)
  const [formKind, setFormKind] = useState<TriggerKind>('cron')
  const [formLabel, setFormLabel] = useState('')
  const [formConfig, setFormConfig] = useState('0 9 * * MON')

  const teamTriggers = useMemo(
    () => triggers.filter((tr) => tr.teamId === currentTeamId),
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
    const tr: Trigger = {
      id: makeId(),
      kind: formKind,
      teamId: currentTeamId,
      label: formLabel,
      config: configField,
      enabled: true,
    }
    addTrigger(tr)
    setShowForm(false)
    setFormLabel('')
    setFormConfig('')
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-neutral-200 flex items-center justify-between">
        <span className="text-[15px] text-neutral-500">
          {teamTriggers.length === 1
            ? t('triggers.countOne')
            : t('triggers.countOther', { n: teamTriggers.length })}
        </span>
        <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)}>
          <Plus className="w-3.5 h-3.5" />
          {t('common.add')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {showForm && (
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 space-y-2">
            <div className="text-[15px] font-medium text-neutral-500">{t('triggers.new')}</div>
            <select
              value={formKind}
              onChange={(e) => setFormKind(e.target.value as TriggerKind)}
              className="w-full px-2.5 py-1.5 text-[15px] rounded-sm border border-neutral-300 bg-white"
            >
              {(Object.entries(KIND_META) as [TriggerKind, (typeof KIND_META)[TriggerKind]][]).map(
                ([k, v]) => (
                  <option key={k} value={k}>
                    {t(v.labelKey)}
                  </option>
                ),
              )}
            </select>
            <input
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder={t('triggers.labelPlaceholder')}
              className="w-full px-2.5 py-1.5 text-[15px] rounded-sm border border-neutral-300 bg-white"
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
              className="w-full px-2.5 py-1.5 text-[15px] font-mono rounded-sm border border-neutral-300 bg-white"
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                {t('settings.cancel')}
              </Button>
              <Button size="sm" variant="primary" onClick={save}>
                {t('settings.save')}
              </Button>
            </div>
          </div>
        )}

        {teamTriggers.length === 0 && !showForm && (
          <div className="text-[15px] text-neutral-400 text-center py-10">
            {t('triggers.empty')}
          </div>
        )}

        {teamTriggers.map((tr) => {
          const Icon = KIND_META[tr.kind].icon
          const label = t(KIND_META[tr.kind].labelKey)
          const configStr = Object.entries(tr.config)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(' · ')
          return (
            <div
              key={tr.id}
              className={clsx(
                'rounded-md border bg-white px-3 py-2.5 flex items-start gap-2.5',
                tr.enabled ? 'border-neutral-200' : 'border-neutral-200 opacity-60',
              )}
            >
              <div className="mt-0.5 w-7 h-7 rounded-sm bg-neutral-100 flex items-center justify-center">
                <Icon className="w-3.5 h-3.5 text-neutral-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-medium text-neutral-900 truncate">{tr.label}</span>
                  <span className="text-[14px] font-semibold uppercase tracking-wide text-neutral-400">
                    {label}
                  </span>
                </div>
                <div className="text-[15px] text-neutral-500 font-mono truncate mt-0.5">
                  {configStr}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggleTrigger(tr.id)}
                  className={clsx(
                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                    tr.enabled ? 'bg-emerald-500' : 'bg-neutral-300',
                  )}
                  aria-label={tr.enabled ? t('triggers.disable') : t('triggers.enable')}
                >
                  <span
                    className={clsx(
                      'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                      tr.enabled ? 'translate-x-4' : 'translate-x-0.5',
                    )}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => removeTrigger(tr.id)}
                  aria-label={t('triggers.removeTrigger')}
                  className="p-1 rounded-sm text-neutral-400 hover:text-red-600 hover:bg-red-50"
                >
                  <Trash className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
