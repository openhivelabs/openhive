import { CircleNotch, Sparkle, Warning, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { PanelShape } from '@/components/dashboard/BoundPanel'
import {
  type PanelTemplate,
  buildBinding,
  fetchPanelTemplates,
  previewBinding,
} from '@/lib/api/panels'
import type { PanelBinding, PanelSpec } from '@/lib/api/dashboards'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'

/**
 * Two-step modal:
 *  - Create mode: pick a template → describe data → AI fills binding → preview → save
 *  - Edit mode:   skip the gallery, open the builder pre-filled with `existingSpec`
 *
 * The builder is the same component either way; only the entry path + the save
 * callback differ. `existingSpec` makes the builder start populated.
 */
export function AddPanelModal({
  open,
  teamId,
  existingSpec,
  onClose,
  onAdd,
  onUpdate,
}: {
  open: boolean
  teamId: string | null
  /** When set, modal skips the gallery and opens the builder in edit mode. */
  existingSpec?: PanelSpec | null
  onClose: () => void
  onAdd: (spec: PanelSpec) => void
  /** Called on save in edit mode (instead of onAdd). */
  onUpdate?: (spec: PanelSpec) => void
}) {
  const [templates, setTemplates] = useState<PanelTemplate[]>([])
  const [chosen, setChosen] = useState<PanelTemplate | null>(null)

  useEffect(() => {
    if (!open) return
    void fetchPanelTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [open])

  // In edit mode, synthesise a template from the existing spec so the builder
  // can reuse the same state machine. The binding_skeleton field is left
  // empty — AI won't be re-used unless the user clicks Generate again.
  const editingTemplate = useMemo<PanelTemplate | null>(() => {
    if (!existingSpec) return null
    return {
      id: existingSpec.id,
      name: existingSpec.title || 'Panel',
      description: '',
      icon: '✏️',
      category: 'custom',
      panel: {
        type: existingSpec.type,
        colSpan: existingSpec.colSpan,
        rowSpan: existingSpec.rowSpan,
        props: existingSpec.props,
      },
      binding_skeleton: (existingSpec.binding as unknown as Record<string, unknown>) || {},
      ai_prompts: {},
    }
  }, [existingSpec])

  const activeTemplate = editingTemplate ?? chosen
  const isEditing = !!editingTemplate

  useEscapeClose(open, () => {
    if (chosen && !isEditing) setChosen(null)
    else onClose()
  })

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={() => {
        if (chosen && !isEditing) setChosen(null)
        else onClose()
      }}
      onKeyDown={(e) =>
        e.key === 'Escape' && (chosen && !isEditing ? setChosen(null) : onClose())
      }
    >
      <div
        className="w-[1080px] max-w-[96vw] h-[86vh] rounded-md bg-white shadow-xl border border-neutral-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold">
            {isEditing
              ? `Edit panel — ${existingSpec?.title ?? ''}`
              : chosen
                ? `Configure "${chosen.name}"`
                : 'Add panel'}
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

        {!activeTemplate ? (
          <TemplateGallery templates={templates} onPick={setChosen} />
        ) : (
          <BindingBuilder
            template={activeTemplate}
            teamId={teamId}
            existingSpec={existingSpec ?? null}
            onBack={isEditing ? onClose : () => setChosen(null)}
            onSave={(spec) => {
              if (isEditing && onUpdate) onUpdate(spec)
              else onAdd(spec)
              setChosen(null)
              onClose()
            }}
          />
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------

function TemplateGallery({
  templates,
  onPick,
}: {
  templates: PanelTemplate[]
  onPick: (t: PanelTemplate) => void
}) {
  const groups = useMemo(() => {
    const map = new Map<string, PanelTemplate[]>()
    for (const t of templates) {
      if (!map.has(t.category)) map.set(t.category, [])
      map.get(t.category)!.push(t)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [templates])

  if (templates.length === 0) {
    return (
      <div className="px-5 py-8 text-center text-[13px] text-neutral-400">
        Loading templates…
      </div>
    )
  }

  return (
    <div className="overflow-y-auto px-6 py-5 space-y-6">
      <p className="text-[13px] text-neutral-500">
        Pick a panel shape. In the next step you describe the data in plain
        language and the AI fills in the binding.
      </p>
      {groups.map(([cat, items]) => (
        <section key={cat}>
          <div className="text-[11.5px] uppercase tracking-wide font-semibold text-neutral-400 mb-2">
            {cat}
          </div>
          <div className="grid grid-cols-3 gap-3">
            {items.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t)}
                className="text-left rounded-md border border-neutral-200 bg-white hover:border-neutral-500 hover:shadow-md transition-all overflow-hidden flex flex-col"
              >
                <div className="h-[120px] bg-neutral-50 border-b border-neutral-200 flex items-center justify-center p-3">
                  <ShapeThumbnail panelType={t.panel.type} />
                </div>
                <div className="p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[16px]">{t.icon || '▦'}</span>
                    <span className="font-semibold text-neutral-900 text-[14px] truncate">
                      {t.name}
                    </span>
                    <span className="ml-auto text-[10.5px] text-neutral-400 font-mono">
                      {t.panel.type}
                    </span>
                  </div>
                  <p className="text-[12px] text-neutral-500 mt-1 leading-snug line-clamp-2">
                    {t.description}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** Tiny stylized sketch of what each panel type looks like — used in gallery
 *  cards so the user can see shape at a glance without reading the label. */
function ShapeThumbnail({ panelType }: { panelType: string }) {
  if (panelType === 'kpi') {
    return (
      <div className="flex flex-col gap-1.5 items-start w-full">
        <div className="h-1.5 w-10 rounded bg-neutral-300" />
        <div className="h-7 w-16 rounded bg-neutral-800" />
      </div>
    )
  }
  if (panelType === 'table') {
    return (
      <div className="w-full space-y-1">
        <div className="h-1.5 bg-neutral-400 rounded" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-1.5 bg-neutral-200 rounded" />
        ))}
      </div>
    )
  }
  if (panelType === 'kanban') {
    return (
      <div className="w-full grid grid-cols-3 gap-1.5">
        {Array.from({ length: 3 }).map((_, c) => (
          <div key={c} className="rounded bg-neutral-100 border border-neutral-200 p-1 space-y-1">
            <div className="h-1.5 bg-neutral-400 rounded" />
            <div className="h-3 bg-white border border-neutral-200 rounded" />
            <div className="h-3 bg-white border border-neutral-200 rounded" />
          </div>
        ))}
      </div>
    )
  }
  if (panelType === 'chart') {
    const heights = [50, 70, 30, 85, 45]
    return (
      <div className="flex items-end gap-1 h-full w-full">
        {heights.map((h, i) => (
          <div
            key={i}
            className="flex-1 bg-amber-400 rounded-t"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    )
  }
  if (panelType === 'list') {
    return (
      <div className="w-full space-y-1.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-400" />
            <div className="h-1.5 flex-1 bg-neutral-300 rounded" />
          </div>
        ))}
      </div>
    )
  }
  if (panelType === 'note') {
    return (
      <div className="w-full space-y-1">
        <div className="h-1.5 bg-neutral-400 rounded w-1/2" />
        <div className="h-1.5 bg-neutral-200 rounded" />
        <div className="h-1.5 bg-neutral-200 rounded" />
        <div className="h-1.5 bg-neutral-200 rounded w-3/4" />
      </div>
    )
  }
  return <div className="w-full h-full bg-neutral-200 rounded" />
}

// -----------------------------------------------------------------------------

function BindingBuilder({
  template,
  teamId,
  existingSpec,
  onBack,
  onSave,
}: {
  template: PanelTemplate
  teamId: string | null
  existingSpec?: PanelSpec | null
  onBack: () => void
  onSave: (spec: PanelSpec) => void
}) {
  const [goal, setGoal] = useState('')
  const [title, setTitle] = useState(existingSpec?.title || template.name)
  const [binding, setBinding] = useState<Record<string, unknown> | null>(
    existingSpec?.binding ? (existingSpec.binding as unknown as Record<string, unknown>) : null,
  )
  const [previewData, setPreviewData] = useState<unknown>(null)
  const [busy, setBusy] = useState<'build' | 'preview' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [colSpan, setColSpan] = useState<1 | 2 | 3 | 4>(
    ((existingSpec?.colSpan as 1 | 2 | 3 | 4) ?? (template.panel.colSpan as 1 | 2 | 3 | 4)) || 2,
  )
  const [rowSpan, setRowSpan] = useState<1 | 2 | 3 | 4>(
    ((existingSpec?.rowSpan as 1 | 2 | 3 | 4) ?? (template.panel.rowSpan as 1 | 2 | 3 | 4)) || 1,
  )

  const panelType = template.panel.type
  const isEditing = !!existingSpec

  // On mount in edit mode, session preview once so the user sees current data.
  useEffect(() => {
    if (isEditing && teamId && binding) {
      void (async () => {
        const p = await previewBinding(teamId, panelType, binding).catch(() => null)
        if (p?.ok) setPreviewData(p.data)
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runBuild = async () => {
    if (!teamId || !goal.trim()) return
    setBusy('build')
    setError(null)
    setPreviewData(null)
    try {
      const built = await buildBinding(teamId, template.id, goal.trim())
      setBinding(built.binding)
      const p = await previewBinding(teamId, built.panel_type, built.binding)
      if (p.ok) setPreviewData(p.data)
      else setError(p.error || 'preview failed')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const runPreview = async () => {
    if (!teamId || !binding) return
    setBusy('preview')
    setError(null)
    try {
      const p = await previewBinding(teamId, panelType, binding)
      if (p.ok) setPreviewData(p.data)
      else setError(p.error || 'preview failed')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const save = () => {
    if (!binding) return
    const id = existingSpec?.id || `p_${Math.random().toString(36).slice(2, 8)}`
    const spec: PanelSpec = {
      id,
      type: panelType as PanelSpec['type'],
      title: title || template.name,
      colSpan,
      rowSpan,
      props: (template.panel.props as Record<string, unknown>) ?? existingSpec?.props ?? {},
      binding: binding as unknown as PanelBinding,
    }
    onSave(spec)
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left column — form */}
      <div className="w-[400px] shrink-0 border-r border-neutral-200 flex flex-col">
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div>
            <label className="text-[12.5px] font-medium text-neutral-600">Panel title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full px-2.5 py-1.5 text-[14px] rounded-sm border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
            />
          </div>
          <div>
            <label className="text-[12.5px] font-medium text-neutral-600">
              Describe what this panel should show
            </label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={4}
              placeholder="e.g. Show deals closing this month, grouped by stage, sorted by amount"
              className="mt-1 w-full px-2.5 py-1.5 text-[14px] rounded-sm border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300 font-[inherit]"
            />
            <div className="text-[11.5px] text-neutral-400 mt-1">
              AI picks from available data sources (team DB + connected MCP servers) and fills in the SQL / tool args.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runBuild}
              disabled={busy !== null || !goal.trim() || !teamId}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-sm bg-amber-500 text-white text-[13px] font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'build' ? (
                <CircleNotch className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkle className="w-3.5 h-3.5" />
              )}
              {busy === 'build' ? 'Thinking…' : 'Generate'}
            </button>
            {binding && (
              <button
                type="button"
                onClick={runPreview}
                disabled={busy !== null}
                className="h-8 px-2.5 rounded-sm border border-neutral-300 text-[13px] hover:bg-neutral-50 disabled:opacity-50"
              >
                {busy === 'preview' ? 'Running…' : 'Re-session'}
              </button>
            )}
          </div>

          {error && (
            <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2 whitespace-pre-wrap font-mono">
              <Warning className="inline w-3.5 h-3.5 mr-1" />
              {error}
            </div>
          )}

          <div className="pt-2 border-t border-neutral-100 space-y-2">
            <div>
              <label className="text-[12.5px] font-medium text-neutral-600">Width</label>
              <div className="mt-1 grid grid-cols-4 gap-1">
                {([1, 2, 3, 4] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setColSpan(n)}
                    className={
                      colSpan === n
                        ? 'h-7 text-[12.5px] rounded-sm bg-neutral-900 text-white font-medium'
                        : 'h-7 text-[12.5px] rounded-sm border border-neutral-300 hover:bg-neutral-50'
                    }
                  >
                    {n} col
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[12.5px] font-medium text-neutral-600">Height</label>
              <div className="mt-1 grid grid-cols-4 gap-1">
                {([1, 2, 3, 4] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRowSpan(n)}
                    className={
                      rowSpan === n
                        ? 'h-7 text-[12.5px] rounded-sm bg-neutral-900 text-white font-medium'
                        : 'h-7 text-[12.5px] rounded-sm border border-neutral-300 hover:bg-neutral-50'
                    }
                  >
                    {n} row
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-neutral-400 mt-1">
                Each row ≈ 180px. {colSpan}×{rowSpan} on the dashboard grid.
              </div>
            </div>
          </div>

          {binding && (
            <details className="rounded-sm border border-neutral-200">
              <summary className="px-2.5 py-1.5 text-[12.5px] text-neutral-600 cursor-pointer hover:bg-neutral-50">
                Generated binding (advanced)
              </summary>
              <pre className="text-[11px] font-mono p-2.5 bg-neutral-50 overflow-auto max-h-[220px]">
                {JSON.stringify(binding, null, 2)}
              </pre>
            </details>
          )}
        </div>

        <div className="shrink-0 px-5 py-3 border-t border-neutral-200 flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="h-8 px-3 rounded-sm text-[13px] text-neutral-600 hover:bg-neutral-100"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!binding}
            className="h-8 px-3 rounded-sm bg-neutral-900 text-white text-[13px] font-medium hover:opacity-90 disabled:opacity-50"
          >
            Add to dashboard
          </button>
        </div>
      </div>

      {/* Right column — live preview of the actual panel */}
      <div className="flex-1 bg-neutral-50 flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 py-2 border-b border-neutral-200 flex items-center gap-2">
          <span className="text-[12px] uppercase tracking-wide font-semibold text-neutral-400">
            Preview
          </span>
          <span className="text-[11.5px] text-neutral-400 font-mono">{panelType}</span>
          {busy === 'build' && (
            <span className="ml-auto text-[11.5px] text-neutral-400 flex items-center gap-1">
              <CircleNotch className="w-3 h-3 animate-spin" /> generating
            </span>
          )}
        </div>
        <div className="flex-1 overflow-auto p-5 flex items-start justify-center">
          {previewData === null ? (
            <div className="text-[13px] text-neutral-400 pt-12 text-center max-w-[360px]">
              After generating, your panel shows up here rendered exactly how it
              will look on the dashboard.
            </div>
          ) : (
            // Preview card sized to match the chosen grid footprint. The
            // dashboard grid uses col widths in a 4-col layout and ~180px row
            // heights; we mimic that here at a scale fitting the preview pane.
            <div
              className="rounded-md bg-white border border-neutral-200 shadow-sm overflow-hidden flex flex-col"
              style={{
                // Width: proportional to chosen cols (1..4) out of 4, capped.
                width: `${(colSpan / 4) * 100}%`,
                maxWidth: 640,
                minWidth: 240,
                // Height: ~140px per row (slightly tighter than the live grid's
                // 180px so we fit 4 rows comfortably in the preview pane).
                height: `${rowSpan * 140 + 36}px`,
              }}
            >
              <div className="h-9 shrink-0 px-3 flex items-center gap-2 border-b border-neutral-100 bg-neutral-50">
                <span className="text-[14px] font-medium text-neutral-800 truncate">
                  {title || template.name}
                </span>
                <span className="ml-auto text-[11px] text-neutral-400 font-mono">
                  {colSpan}×{rowSpan}
                </span>
              </div>
              <div className="flex-1 overflow-auto">
                <PanelShape
                  panelType={panelType}
                  data={previewData}
                  props={template.panel.props as Record<string, unknown> | undefined}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
