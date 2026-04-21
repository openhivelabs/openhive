'use client'

import { Trash, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { deleteCompany, saveCompany } from '@/lib/api/companies'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import type { Company } from '@/lib/types'
import { Button } from '../ui/Button'

interface Props {
  open: boolean
  companyId: string | null
  onClose: () => void
}

export function CompanySettingsModal({ open, companyId, onClose }: Props) {
  const t = useT()
  const companies = useAppStore((s) => s.companies)
  const company = companies.find((c) => c.id === companyId)
  const [draft, setDraft] = useState<Company | null>(null)

  useEffect(() => {
    if (company) setDraft({ ...company })
  }, [company])

  useEscapeClose(open && company && draft, onClose)

  if (!open || !company || !draft || !companyId) return null

  const save = async () => {
    const next = companies.map((c) => (c.id === companyId ? { ...c, name: draft.name } : c))
    useAppStore.setState({ companies: next })
    await saveCompany({ ...company, name: draft.name }).catch((e) =>
      console.error('saveCompany failed', e),
    )
    onClose()
  }

  const remove = async () => {
    if (
      !confirm(
        `Delete company "${company.name}"? This removes its directory and all teams under it.`,
      )
    )
      return
    await deleteCompany(company.slug).catch(() => null)
    const next = companies.filter((c) => c.id !== companyId)
    const first = next[0]
    useAppStore.setState({
      companies: next,
      currentCompanyId: first?.id ?? '',
      currentTeamId: first?.teams[0]?.id ?? '',
    })
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
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
          <h2 className="text-base font-semibold">
            {t('sidebar.companySettings')} — {company.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-sm hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-[15px] font-medium text-neutral-600">
              {t('teamSettings.name')}
            </label>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="mt-1 w-full px-3 py-1.5 text-[15px] rounded-sm border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
            />
          </div>
          <div className="text-[14px] text-neutral-500">
            <span className="font-mono">{company.slug}</span>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-neutral-200 flex items-center justify-between">
          <Button variant="ghost" onClick={remove}>
            <Trash className="w-3.5 h-3.5" />
            Delete
          </Button>
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
