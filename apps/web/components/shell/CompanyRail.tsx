import { GearSix, Plus, Storefront } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FrameMarketModal } from '@/components/modals/FrameMarketModal'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'

const DRAG_MIME = 'application/x-openhive-company'

/**
 * 52px vertical rail. Always visible across team/settings/other top-level routes.
 * Clicking a company icon jumps to that company's first team dashboard.
 * Companies can be reordered by drag-and-drop (persisted to company.yaml).
 */
export function CompanyRail() {
  const t = useT()
  const navigate = useNavigate()
  const companies = useAppStore((s) => s.companies)
  const currentCompanyId = useAppStore((s) => s.currentCompanyId)
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const setCompany = useAppStore((s) => s.setCompany)
  const reorderCompanies = useAppStore((s) => s.reorderCompanies)
  const selectedId = currentCompanyId || companies[0]?.id

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null)
  const [marketOpen, setMarketOpen] = useState(false)

  function handleDrop(targetId: string, position: 'before' | 'after') {
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null)
      setDropTarget(null)
      return
    }
    const ids = companies.map((c) => c.id).filter((id) => id !== draggingId)
    const idx = ids.indexOf(targetId)
    if (idx === -1) {
      setDraggingId(null)
      setDropTarget(null)
      return
    }
    ids.splice(position === 'before' ? idx : idx + 1, 0, draggingId)
    reorderCompanies(ids)
    setDraggingId(null)
    setDropTarget(null)
  }

  return (
    <aside className="w-[52px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 flex flex-col">
      <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-1.5">
        {companies.map((company) => {
          const active = selectedId === company.id
          const isDragging = draggingId === company.id
          const showBefore = dropTarget?.id === company.id && dropTarget.position === 'before'
          const showAfter = dropTarget?.id === company.id && dropTarget.position === 'after'
          return (
            <div key={company.id} className="relative w-9">
              {showBefore && (
                <div className="absolute -top-0.5 left-0 right-0 h-0.5 bg-amber-500 rounded-full pointer-events-none" />
              )}
              <button
                type="button"
                title={company.name}
                draggable
                onDragStart={(e) => {
                  setDraggingId(company.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(DRAG_MIME, company.id)
                }}
                onDragEnd={() => {
                  setDraggingId(null)
                  setDropTarget(null)
                }}
                onDragOver={(e) => {
                  if (!draggingId || draggingId === company.id) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const rect = e.currentTarget.getBoundingClientRect()
                  const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                  setDropTarget((prev) =>
                    prev?.id === company.id && prev.position === position
                      ? prev
                      : { id: company.id, position },
                  )
                }}
                onDragLeave={(e) => {
                  const next = e.relatedTarget as Node | null
                  if (!next || !e.currentTarget.contains(next)) {
                    setDropTarget((prev) => (prev?.id === company.id ? null : prev))
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (!dropTarget) return
                  handleDrop(dropTarget.id, dropTarget.position)
                }}
                onClick={() => {
                  setCompany(company.id)
                  const firstTeam = company.teams[0]
                  if (firstTeam) navigate(`/${company.slug}/${firstTeam.slug}/dashboard`)
                }}
                className={clsx(
                  'w-9 h-9 rounded-md flex items-center justify-center text-[14px] font-semibold cursor-pointer shrink-0 transition-opacity',
                  isDragging && 'opacity-40',
                  active
                    ? 'bg-amber-500 text-white shadow-sm'
                    : 'bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-200 hover:border-neutral-300',
                )}
              >
                {company.name.slice(0, 1).toUpperCase()}
              </button>
              {showAfter && (
                <div className="absolute -bottom-0.5 left-0 right-0 h-0.5 bg-amber-500 rounded-full pointer-events-none" />
              )}
            </div>
          )
        })}
        <button
          type="button"
          aria-label={t('sidebar.addCompany')}
          onClick={() => navigate('/onboarding')}
          className="w-9 h-9 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 text-neutral-400 hover:text-neutral-700 hover:border-neutral-500 flex items-center justify-center cursor-pointer"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setMarketOpen(true)}
          aria-label="Frame Market"
          title="Frame Market"
          className="mt-6 w-9 h-9 rounded-md flex items-center justify-center text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200/60 dark:hover:bg-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100 cursor-pointer"
        >
          <Storefront className="w-5 h-5" />
        </button>
      </div>
      <Link
        to="/settings"
        aria-label={t('sidebar.settings')}
        title={t('sidebar.settings')}
        className="mx-auto mb-2 w-9 h-9 rounded-md flex items-center justify-center text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200/60 dark:hover:bg-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        <GearSix className="w-5 h-5" />
      </Link>
      <FrameMarketModal
        open={marketOpen}
        onClose={() => setMarketOpen(false)}
        defaultCompanyId={selectedId ?? null}
        defaultTeamId={currentTeamId ?? null}
      />
    </aside>
  )
}
