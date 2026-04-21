'use client'

import { DownloadSimple, Trash, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { deleteTeam } from '@/lib/api/companies'
import { downloadFrame } from '@/lib/api/frames'
import { type InstalledServer, fetchServers } from '@/lib/api/mcp'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import type { Team } from '@/lib/types'
import { Button } from '../ui/Button'

interface Props {
  open: boolean
  companyId: string | null
  teamId: string | null
  onClose: () => void
}

export function TeamSettingsModal({ open, companyId, teamId, onClose }: Props) {
  const t = useT()
  const companies = useAppStore((s) => s.companies)
  const updateTeam = useAppStore((s) => s.updateTeam)
  const company = companies.find((c) => c.id === companyId)
  const team = company?.teams.find((t) => t.id === teamId)

  const [draft, setDraft] = useState<Team | null>(null)
  const [mcpServers, setMcpServers] = useState<InstalledServer[]>([])

  useEffect(() => {
    if (team) setDraft(JSON.parse(JSON.stringify(team)) as Team)
  }, [team])

  useEffect(() => {
    if (!open) return
    void fetchServers().then(setMcpServers).catch(() => setMcpServers([]))
  }, [open])

  useEscapeClose(open && team && draft, onClose)

  if (!open || !team || !draft || !companyId) return null

  const save = () => {
    updateTeam(companyId, draft)
    onClose()
  }

  const remove = async () => {
    if (!company) return
    if (!confirm(t('teamSettings.confirmDelete', { name: team.name }))) return
    await deleteTeam(company.slug, team.slug).catch(() => null)
    // Reload by rewriting the app store without this team.
    const next = companies.map((c) =>
      c.id === companyId ? { ...c, teams: c.teams.filter((t) => t.id !== team.id) } : c,
    )
    useAppStore.setState({ companies: next })
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Team settings"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[520px] max-w-[94vw] rounded-md bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold">{t('teamSettings.title', { name: team.name })}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-sm hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[15px] font-medium text-neutral-600">{t('teamSettings.name')}</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="mt-1 w-full px-3 py-1.5 text-[15px] rounded-sm border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
            />
          </div>

          <div>
            <div className="text-[15px] font-medium text-neutral-600">
              {t('teamSettings.allowedMcp')}
            </div>
            <p className="text-[13px] text-neutral-500 mt-0.5">
              {t('teamSettings.allowedMcpHint')}
            </p>
            {mcpServers.length === 0 ? (
              <div className="mt-2 text-[13px] text-neutral-400 border border-dashed border-neutral-300 rounded-sm px-3 py-2">
                {t('teamSettings.noMcpInstalled')}
              </div>
            ) : (
              <div className="mt-2 space-y-1">
                {mcpServers.map((s) => {
                  const allowed = (draft.allowedMcpServers ?? []).includes(s.name)
                  return (
                    <label
                      key={s.name}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-neutral-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={allowed}
                        onChange={(e) => {
                          const list = new Set(draft.allowedMcpServers ?? [])
                          if (e.target.checked) list.add(s.name)
                          else list.delete(s.name)
                          setDraft({ ...draft, allowedMcpServers: Array.from(list) })
                        }}
                      />
                      <span className="text-[14px] font-medium text-neutral-900">
                        {s.name}
                      </span>
                      <span className="text-[12px] text-neutral-400 font-mono">
                        {s.preset_id ?? 'custom'}
                      </span>
                      <span className="ml-auto text-[12px] text-neutral-500">
                        {s.tool_count !== null ? `${s.tool_count} tools` : '—'}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

        </div>

        <div className="px-5 py-3 border-t border-neutral-200 flex items-center justify-between">
          <div className="flex gap-2">
            <Button variant="ghost" onClick={remove}>
              <Trash className="w-3.5 h-3.5" />
              {t('teamSettings.delete')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => company && downloadFrame(company.slug, team.slug)}
              title={t('teamSettings.saveFrameHint')}
            >
              <DownloadSimple className="w-3.5 h-3.5" />
              {t('teamSettings.saveFrame')}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('settings.cancel')}
            </Button>
            <Button variant="primary" onClick={save}>
              {t('settings.save')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
