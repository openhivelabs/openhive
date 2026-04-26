import { CircleNotch, X } from '@phosphor-icons/react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { BindingCodeEditor } from '@/components/dashboard/BindingCodeEditor'
import { PanelShape } from '@/components/dashboard/BoundPanel'
import type { PanelBinding, PanelSpec } from '@/lib/api/dashboards'
import { previewBinding, rebindPanel } from '@/lib/api/panels'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'

type Span = 1 | 2 | 3 | 4 | 5 | 6
const SPANS: readonly Span[] = [1, 2, 3, 4, 5, 6]
/** Px per grid unit inside the preview pane. Mirrors the dashboard's cell
 *  shape (square) so a 1×1 preview is square, just like on the board.
 *  Smaller than the live grid (195) so 6×6 fits in the modal. */
const PREVIEW_UNIT = 110
const PREVIEW_GAP = 12

/**
 * Panel edit modal. The original component supported both an "Add" gallery
 * flow and an "Edit" pre-filled flow; the gallery is no longer reachable
 * (Add is now driven by FrameMarketModal), so this is purely the edit flow,
 * trimmed down to match the Frame Market detail view's tighter layout.
 */
export function AddPanelModal({
  open,
  teamId,
  existingSpec,
  onClose,
  onUpdate,
}: {
  open: boolean
  teamId: string | null
  existingSpec?: PanelSpec | null
  onClose: () => void
  /** Unused — Add flow is now FrameMarketModal. Kept on the prop list for
   *  call-site backwards compat. */
  onAdd?: (spec: PanelSpec) => void
  onUpdate?: (spec: PanelSpec) => void
}) {
  const t = useT()

  const [title, setTitle] = useState(existingSpec?.title ?? '')
  const [intent, setIntent] = useState('')
  const [binding, setBinding] = useState<PanelBinding | null>(
    (existingSpec?.binding as PanelBinding | undefined) ?? null,
  )
  const [data, setData] = useState<unknown>(null)
  const [busy, setBusy] = useState<'rebind' | 'preview' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [colSpan, setColSpan] = useState<Span>(
    (existingSpec?.colSpan as Span) ?? 2,
  )
  const [rowSpan, setRowSpan] = useState<Span>(
    (existingSpec?.rowSpan as Span) ?? 2,
  )

  // When the modal (re)opens with a new spec, sync local state.
  useEffect(() => {
    if (!open || !existingSpec) return
    setTitle(existingSpec.title ?? '')
    setIntent('')
    setBinding((existingSpec.binding as PanelBinding | undefined) ?? null)
    setData(null)
    setBusy(null)
    setError(null)
    setColSpan((existingSpec.colSpan as 1 | 2 | 3 | 4) ?? 2)
    setRowSpan((existingSpec.rowSpan as 1 | 2 | 3 | 4) ?? 2)
  }, [open, existingSpec])

  // Show the existing data once on open so the preview isn't blank.
  useEffect(() => {
    if (!open || !teamId || !existingSpec?.binding) return
    let cancelled = false
    void (async () => {
      const r = await previewBinding(
        teamId,
        existingSpec.type,
        existingSpec.binding as unknown as Record<string, unknown>,
      ).catch(() => null)
      if (!cancelled && r?.ok) setData(r.data)
    })()
    return () => {
      cancelled = true
    }
  }, [open, teamId, existingSpec])

  useEscapeClose(open, onClose)
  if (!open || !existingSpec) return null

  const onApply = async () => {
    if (!teamId) return
    setBusy('rebind')
    setError(null)
    try {
      const next = await rebindPanel({
        team_id: teamId,
        spec: {
          type: existingSpec.type,
          title: existingSpec.title,
          props: existingSpec.props,
          binding: binding ?? existingSpec.binding,
        } as unknown as Record<string, unknown>,
        user_intent: intent.trim() ? intent.trim() : null,
      })
      setBinding(next.binding as unknown as PanelBinding)
      setData(next.data)
      if (next.error) setError(next.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const save = () => {
    if (!onUpdate) return
    const spec: PanelSpec = {
      ...existingSpec,
      title: title.trim() || existingSpec.title,
      colSpan,
      rowSpan,
      binding: (binding ?? existingSpec.binding) as PanelBinding,
    }
    onUpdate(spec)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('panel.edit.title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[1200px] max-w-[96vw] h-[82vh] max-h-[820px] rounded-md bg-white dark:bg-neutral-900 shadow-xl border border-neutral-200 dark:border-neutral-800 flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-50">
            {t('panel.edit.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 rounded-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — two columns: left form, right live preview */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left column — controls */}
          <div className="w-[360px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 flex flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto">
              {/* Section: title */}
              <Section>
                <label
                  htmlFor="panel-edit-title"
                  className="block text-[12px] font-medium text-neutral-500 dark:text-neutral-400 mb-1.5"
                >
                  {t('panel.edit.panelTitle')}
                </label>
                <input
                  id="panel-edit-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 text-[13px] rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                />
              </Section>

              {/* Section: data */}
              <Section>
                <label
                  htmlFor="panel-edit-intent"
                  className="block text-[12px] font-medium text-neutral-500 dark:text-neutral-400 mb-1.5"
                >
                  {t('panel.edit.data')}
                </label>
                <textarea
                  id="panel-edit-intent"
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  placeholder={t('panel.edit.intentPlaceholder')}
                  rows={3}
                  className="w-full px-3 py-2 text-[13px] rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-300 resize-none"
                />
                <button
                  type="button"
                  onClick={onApply}
                  disabled={busy !== null || !teamId}
                  className="mt-2 w-full inline-flex items-center justify-center gap-1.5 h-8 px-4 text-[13px] rounded-sm bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busy === 'rebind' ? (
                    <CircleNotch className="w-3.5 h-3.5 animate-spin" />
                  ) : null}
                  {busy === 'rebind'
                    ? t('market.install.applying')
                    : t('market.install.apply')}
                </button>
                {error && (
                  <div className="mt-2 text-[12px] text-red-600 dark:text-red-300 font-mono break-all">
                    {error}
                  </div>
                )}
                <BindingCodeEditor
                  binding={binding ?? (existingSpec.binding as PanelBinding)}
                  panelType={existingSpec.type}
                  teamId={teamId}
                  onChange={setBinding}
                  onPreview={setData}
                />
              </Section>

              {/* Section: size */}
              <Section>
                <div className="block text-[12px] font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
                  {t('panel.edit.size')}
                </div>
                <SizePicker
                  label={t('panel.edit.width')}
                  value={colSpan}
                  onChange={(v) => setColSpan(v)}
                />
                <div className="mt-2">
                  <SizePicker
                    label={t('panel.edit.height')}
                    value={rowSpan}
                    onChange={(v) => setRowSpan(v)}
                  />
                </div>
              </Section>
            </div>

            {/* Footer pinned to left column */}
            <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-neutral-200 dark:border-neutral-800">
              <button
                type="button"
                onClick={onClose}
                className="h-8 px-3 rounded-sm text-[13px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
              >
                {t('panel.edit.cancel')}
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!binding || busy !== null}
                className="h-8 px-4 rounded-sm bg-neutral-900 text-white text-[13px] font-medium hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                {t('panel.edit.save')}
              </button>
            </div>
          </div>

          {/* Right column — live preview. Outer scrolls when the preview
              card is bigger than the pane (e.g. 6×6 on a small modal),
              inner wrapper centers when it fits. */}
          <div className="flex-1 min-w-0 bg-neutral-50 dark:bg-neutral-950 overflow-auto relative">
            <div className="min-h-full min-w-full flex items-center justify-center p-6">
              <div
                className="flex flex-col rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-sm overflow-hidden transition-all shrink-0"
                style={{
                  width: `${colSpan * PREVIEW_UNIT + (colSpan - 1) * PREVIEW_GAP}px`,
                  height: `${rowSpan * PREVIEW_UNIT + (rowSpan - 1) * PREVIEW_GAP}px`,
                }}
              >
                <div className="shrink-0 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-700 text-[13px] font-medium text-neutral-700 dark:text-neutral-200 truncate">
                  {title || existingSpec.title}
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  {data == null ? (
                    <div className="h-full flex items-center justify-center text-[12px] text-neutral-400">
                      —
                    </div>
                  ) : (
                    <PanelShape
                      panelType={existingSpec.type}
                      data={data}
                      props={existingSpec.props}
                    />
                  )}
                </div>
              </div>
            </div>
            {busy === 'rebind' && (
              <div className="absolute inset-0 flex items-center justify-center bg-neutral-50/50 dark:bg-neutral-950/50 pointer-events-none">
                <CircleNotch className="w-5 h-5 text-neutral-400 animate-spin" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 last:border-b-0">
      {children}
    </div>
  )
}

function SizePicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: Span
  onChange: (v: Span) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-12 shrink-0 text-[12px] text-neutral-500 dark:text-neutral-400">
        {label}
      </div>
      <div className="flex-1 grid grid-cols-6 gap-1">
        {SPANS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={value === n}
            className={
              value === n
                ? 'h-7 text-[12.5px] rounded-sm bg-neutral-900 text-white font-medium dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
                : 'h-7 text-[12.5px] rounded-sm border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer'
            }
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}
