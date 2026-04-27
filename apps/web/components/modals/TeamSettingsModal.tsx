import { DownloadSimple, Trash, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { deleteTeam } from '@/lib/api/companies'
import { downloadFrame } from '@/lib/api/frames'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import type { Team } from '@/lib/types'
import { DEFAULT_TEAM_ICON_KEY, IconPickerButton } from '../shell/TeamIcon'
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

  useEffect(() => {
    if (team) setDraft(JSON.parse(JSON.stringify(team)) as Team)
  }, [team])

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
      aria-label={t('teamSettings.title')}
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
          <h2 className="text-base font-semibold">{t('teamSettings.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.close')}
            className="p-1 rounded-sm hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[15px] font-medium text-neutral-600">{t('teamSettings.name')}</label>
            <div className="mt-1 flex items-stretch gap-2">
              <IconPickerButton
                value={draft.icon ?? DEFAULT_TEAM_ICON_KEY}
                onChange={(k) => setDraft({ ...draft, icon: k })}
              />
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="flex-1 px-3 py-1.5 text-[15px] rounded-sm border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
              />
            </div>
          </div>

        </div>

        <div className="px-5 py-3 border-t border-neutral-200 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={remove}
              aria-label={t('teamSettings.delete')}
              title={t('teamSettings.delete')}
              className="inline-flex items-center justify-center w-8 h-8 rounded-sm text-neutral-500 hover:bg-neutral-100 hover:text-red-600 transition-colors"
            >
              <Trash className="w-[18px] h-[18px]" />
            </button>
            <button
              type="button"
              onClick={() => company && downloadFrame(company.slug, team.slug)}
              aria-label={t('teamSettings.saveFrame')}
              title={t('teamSettings.saveFrameHint')}
              className="inline-flex items-center justify-center w-8 h-8 rounded-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 transition-colors"
            >
              <DownloadSimple className="w-[18px] h-[18px]" />
            </button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} className="h-8">
              {t('settings.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={save} className="h-8">
              {t('settings.save')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

