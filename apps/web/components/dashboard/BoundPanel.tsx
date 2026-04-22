import { useState } from 'react'
import { ArrowsClockwise, Plus, TrashSimple, Warning } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { usePanelData } from '@/lib/hooks/usePanelData'
import type { CellAction, PanelAction, PanelSpec } from '@/lib/api/dashboards'
import { refreshPanel } from '@/lib/api/panels'
import { useT } from '@/lib/i18n'
import { ActionFormModal, runConfirmAction } from './ActionForm'

/** Renders a panel whose `binding` is set — data comes from the server's
 *  block cache (refreshed by the scheduler). The frontend is dumb: it trusts
 *  the mapper has already shaped the response to match the block's type.
 *
 *  A Cell is an interactive unit inside a panel (table row, kanban card, list
 *  item). When the binding declares `map.on_click`, Cells become clickable
 *  and trigger the action (detail modal, open URL, …). */
export function BoundPanel({ spec, teamId }: { spec: PanelSpec; teamId?: string }) {
  const t = useT()
  const { data, error, fetchedAt, shapeChanged } = usePanelData(spec.id, true)
  const onClick = spec.binding?.map?.on_click ?? null
  const actions = spec.binding?.actions ?? []
  const toolbarActions = actions.filter((a) => a.placement === 'toolbar')
  const rowActions = actions.filter((a) => a.placement === 'row')
  const inlineActions = actions.filter((a) => a.placement === 'inline')
  const [openAction, setOpenAction] = useState<PanelAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshPanel(spec.id)
    } catch {
      /* usePanelData surfaces error on next stream tick */
    } finally {
      setRefreshing(false)
    }
  }

  const header = (
    <div className="px-3 py-2 flex items-center gap-2 border-b border-neutral-100 dark:border-neutral-800">
      <span className="flex-1 truncate text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">
        {spec.title}
      </span>
      {fetchedAt != null && (
        <span className="text-[11px] text-neutral-400 font-mono">
          {formatRelative(fetchedAt, t)}
        </span>
      )}
      {shapeChanged && (
        <span
          title={t('panel.shapeChanged')}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40"
        >
          <Warning className="w-3 h-3" />
          <span>{t('panel.shapeChangedShort')}</span>
        </span>
      )}
      {teamId &&
        toolbarActions.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              if (a.form?.fields?.length) setOpenAction(a)
              else
                runConfirmAction({
                  panelId: spec.id,
                  teamId,
                  action: a,
                  values: {},
                  t,
                  onSuccess: handleRefresh,
                  onError: setActionError,
                })
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-sm text-[12px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
            title={a.label}
          >
            <Plus className="w-3 h-3" />
            <span>{a.label}</span>
          </button>
        ))}
      <button
        type="button"
        aria-label={t('panel.refresh')}
        title={t('panel.refresh')}
        onClick={handleRefresh}
        className={clsx(
          'w-6 h-6 flex items-center justify-center rounded-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer',
          refreshing && 'animate-spin',
        )}
      >
        <ArrowsClockwise className="w-3.5 h-3.5" />
      </button>
    </div>
  )

  const body = (() => {
    if (error && data == null) {
      return (
        <div className="p-4 text-[13px] text-red-600 dark:text-red-400 flex items-start gap-2">
          <Warning className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1 whitespace-pre-wrap font-mono">{error}</div>
          <button
            type="button"
            onClick={handleRefresh}
            className="text-[12px] underline hover:no-underline cursor-pointer shrink-0"
          >
            {t('panel.retry')}
          </button>
        </div>
      )
    }
    if (data == null) {
      return <div className="p-4 text-[13px] text-neutral-400">Loading…</div>
    }
    return (
      <PanelShape
        panelType={spec.type}
        data={data}
        props={spec.props}
        onClick={onClick}
        rowActions={rowActions}
        inlineActions={inlineActions}
        allActions={actions}
        groupBy={spec.binding?.map?.group_by}
        panelId={spec.id}
        teamId={teamId}
        onRowActionDone={handleRefresh}
        onRowActionError={setActionError}
      />
    )
  })()

  return (
    <div className="h-full flex flex-col">
      {header}
      {error && data != null && (
        <div className="px-3 py-1 text-[12px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/40 flex items-center gap-1.5">
          <Warning className="w-3 h-3 shrink-0" />
          <span className="flex-1 truncate">{error}</span>
          <button
            type="button"
            onClick={handleRefresh}
            className="underline hover:no-underline cursor-pointer"
          >
            {t('panel.retry')}
          </button>
        </div>
      )}
      {actionError && (
        <div className="px-3 py-1 text-[12px] text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 flex items-center gap-1.5">
          <span className="flex-1 truncate">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="underline hover:no-underline cursor-pointer"
          >
            OK
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">{body}</div>
      {openAction && teamId && (
        <ActionFormModal
          panelId={spec.id}
          teamId={teamId}
          action={openAction}
          onClose={() => setOpenAction(null)}
          onSuccess={handleRefresh}
        />
      )}
    </div>
  )
}

function formatRelative(ts: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const diff = Math.max(0, Date.now() - ts)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('panel.justNow')
  if (mins < 60) return t('panel.minutesAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('panel.hoursAgo', { n: hours })
  return t('panel.daysAgo', { n: Math.floor(hours / 24) })
}

/** Pure renderer — takes (type, data, props) and draws using the per-type
 *  views below. Used by BoundPanel AND by the Add-Panel modal's preview,
 *  so users see their panel in its real visual form before saving. */
export function PanelShape({
  panelType,
  data,
  props,
  onClick,
  rowActions,
  inlineActions,
  allActions,
  groupBy,
  panelId,
  teamId,
  onRowActionDone,
  onRowActionError,
}: {
  panelType: string
  data: unknown
  props?: Record<string, unknown>
  onClick?: CellAction | null
  rowActions?: PanelAction[]
  inlineActions?: PanelAction[]
  allActions?: PanelAction[]
  groupBy?: string
  panelId?: string
  teamId?: string
  onRowActionDone?: () => void
  onRowActionError?: (msg: string) => void
}) {
  const t = useT()
  const [detail, setDetail] = useState<unknown>(null)

  const rowActs = rowActions ?? []
  const rowActionHandler = teamId && panelId && rowActs.length > 0
    ? async (row: Record<string, unknown>, action: PanelAction) => {
        const values: Record<string, unknown> = {}
        // Pass row's primitive fields as potential :id / :status bindings.
        for (const [k, v] of Object.entries(row)) {
          if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
            values[k] = v
          }
        }
        await runConfirmAction({
          panelId,
          teamId,
          action,
          values,
          t,
          onSuccess: onRowActionDone,
          onError: onRowActionError,
        })
      }
    : null

  const dispatch = (raw: unknown) => {
    if (!onClick) return
    if (onClick.kind === 'detail') {
      setDetail(raw)
      return
    }
    if (onClick.kind === 'open_url') {
      const url = pickPath(raw, onClick.url_field)
      if (typeof url === 'string' && url.length > 0) {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      return
    }
  }

  const body = (() => {
    switch (panelType) {
      case 'kpi':
        return <KpiView data={data as KpiShape} hint={String(props?.hint ?? '')} />
      case 'table':
        return (
          <TableView
            data={data as TableShape}
            onCellClick={onClick ? dispatch : null}
            rowActions={rowActs}
            onRowAction={rowActionHandler}
            inlineActions={inlineActions ?? []}
            allActions={allActions ?? []}
            panelId={panelId}
            teamId={teamId}
            onInlineDone={onRowActionDone}
            onInlineError={onRowActionError}
          />
        )
      case 'kanban':
        return (
          <KanbanView
            data={data as KanbanShape}
            onCellClick={onClick ? dispatch : null}
            inlineActions={inlineActions ?? []}
            groupBy={groupBy}
            panelId={panelId}
            teamId={teamId}
            onDone={onRowActionDone}
            onError={onRowActionError}
          />
        )
      case 'chart':
        return <ChartView data={data as ChartShape} />
      case 'list':
        return <ListView data={data as ListShape} onCellClick={onClick ? dispatch : null} />
      case 'note':
        return (
          <div className="p-3 text-[14px] text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap">
            {String(props?.text ?? '')}
          </div>
        )
      default:
        return (
          <pre className="p-3 text-[12px] font-mono text-neutral-500 overflow-auto">
            {JSON.stringify(data, null, 2)}
          </pre>
        )
    }
  })()

  return (
    <>
      {body}
      {detail != null && <DetailModal raw={detail} onClose={() => setDetail(null)} />}
    </>
  )
}

// ---------- per-type renderers ----------------------------------------------

interface KpiShape {
  value: number | string | null
  rows_considered?: number
}
function KpiView({ data, hint }: { data: KpiShape; hint: string }) {
  const display =
    typeof data.value === 'number'
      ? Intl.NumberFormat().format(data.value)
      : String(data.value ?? '—')
  return (
    <div className="h-full flex flex-col justify-between p-4">
      <div className="text-[13px] text-neutral-400">{hint}</div>
      <div className="text-[32px] font-semibold text-neutral-900 dark:text-neutral-100 tracking-tight">
        {display}
      </div>
    </div>
  )
}

interface TableShape {
  columns: string[]
  rows: Record<string, unknown>[]
}
function TableView({
  data,
  onCellClick,
  rowActions,
  onRowAction,
  inlineActions,
  allActions,
  panelId,
  teamId,
  onInlineDone,
  onInlineError,
}: {
  data: TableShape
  onCellClick: ((raw: unknown) => void) | null
  rowActions?: PanelAction[]
  onRowAction?: ((row: Record<string, unknown>, action: PanelAction) => void) | null
  inlineActions?: PanelAction[]
  allActions?: PanelAction[]
  panelId?: string
  teamId?: string
  onInlineDone?: () => void
  onInlineError?: (msg: string) => void
}) {
  const [editing, setEditing] = useState<{ rowIdx: number; col: string } | null>(null)
  // Map column → first inline action that lists it in `fields`.
  const inlineByCol = new Map<string, PanelAction>()
  for (const a of inlineActions ?? []) {
    for (const f of a.fields ?? []) {
      if (!inlineByCol.has(f)) inlineByCol.set(f, a)
    }
  }
  const commitInline = async (
    row: Record<string, unknown>,
    col: string,
    newValue: unknown,
  ) => {
    const action = inlineByCol.get(col)
    if (!action || !panelId || !teamId) {
      setEditing(null)
      return
    }
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      const values: Record<string, unknown> = { ...row, [col]: newValue }
      // Keep only primitives (ids etc) — excludes nested objects.
      for (const [k, v] of Object.entries(values)) {
        if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
          delete values[k]
        }
      }
      await executePanelAction(panelId, action.id, teamId, values)
      onInlineDone?.()
    } catch (e) {
      onInlineError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setEditing(null)
    }
  }
  if (!data.rows?.length) {
    return <div className="p-4 text-[13px] text-neutral-400">(no rows)</div>
  }
  const clickable = !!onCellClick
  const acts = rowActions ?? []
  const hasActions = acts.length > 0 && !!onRowAction
  return (
    <table className="w-full text-[13px]">
      <thead className="bg-neutral-50 dark:bg-neutral-900 sticky top-0">
        <tr>
          {data.columns.map((c) => (
            <th
              key={c}
              className="text-left font-medium text-neutral-500 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800"
            >
              {c}
            </th>
          ))}
          {hasActions && (
            <th className="w-10 border-b border-neutral-200 dark:border-neutral-800" />
          )}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => (
          <tr
            key={i}
            onClick={clickable ? () => onCellClick!(r) : undefined}
            className={
              'group hover:bg-neutral-50 dark:hover:bg-neutral-800/50 ' +
              (clickable ? 'cursor-pointer' : '')
            }
          >
            {data.columns.map((c) => {
              const editable = inlineByCol.has(c)
              const isEditing = editing?.rowIdx === i && editing.col === c
              return (
                <td
                  key={c}
                  onClick={(e) => {
                    // Editable cells own their own click semantics — don't let
                    // the row-level "open detail" handler eat the user's
                    // double-click, and keep single-click focused on the cell.
                    if (editable || isEditing) e.stopPropagation()
                  }}
                  onDoubleClick={(e) => {
                    if (!editable) return
                    e.stopPropagation()
                    setEditing({ rowIdx: i, col: c })
                  }}
                  className={clsx(
                    'px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 text-neutral-800 dark:text-neutral-100 truncate',
                    editable && !isEditing && 'cursor-text hover:outline-1 hover:outline-dashed hover:outline-amber-300',
                  )}
                >
                  {isEditing ? (
                    <InlineCellInput
                      action={inlineByCol.get(c)!}
                      allActions={allActions ?? []}
                      column={c}
                      initial={r[c]}
                      onCommit={(v) => commitInline(r, c, v)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    fmt(r[c])
                  )}
                </td>
              )
            })}
            {hasActions && (
              <td className="px-1 border-b border-neutral-100 dark:border-neutral-800 text-right">
                <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {acts.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRowAction!(r, a)
                      }}
                      aria-label={a.label}
                      title={a.label}
                      className={clsx(
                        'w-6 h-6 flex items-center justify-center rounded-sm cursor-pointer',
                        a.kind === 'delete'
                          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40'
                          : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                      )}
                    >
                      {a.kind === 'delete' ? (
                        <TrashSimple className="w-3.5 h-3.5" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                    </button>
                  ))}
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function InlineCellInput({
  action,
  allActions,
  column,
  initial,
  onCommit,
  onCancel,
}: {
  action: PanelAction
  allActions?: PanelAction[]
  column: string
  initial: unknown
  onCommit: (v: unknown) => void
  onCancel: () => void
}) {
  // Inline update actions usually declare just the mutated column names
  // (`fields: [status]`) without repeating a full FormField schema. To pick
  // the right control (text vs select vs number), we look across EVERY action
  // on this panel for a matching field definition — the `create` action's
  // form typically has the richest schema (type, options, min/max) and we
  // borrow that rather than fall through to a bare text input.
  const field =
    action.form?.fields?.find((f) => f.name === column) ??
    (allActions ?? [])
      .flatMap((a) => a.form?.fields ?? [])
      .find((f) => f.name === column)
  const [value, setValue] = useState<string>(() =>
    initial === null || initial === undefined ? '' : String(initial),
  )
  const commit = () => {
    if (field?.type === 'number') onCommit(value === '' ? null : Number(value))
    else if (field?.type === 'toggle') onCommit(value === 'true')
    else onCommit(value)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') onCancel()
  }
  const base =
    'w-full px-1.5 py-0.5 rounded-sm text-[13px] border border-amber-400 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-amber-400/60'
  if (field?.type === 'select') {
    return (
      <select
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        className={base}
      >
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      autoFocus
      type={field?.type === 'number' ? 'number' : 'text'}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      className={base}
    />
  )
}

interface KanbanShape {
  groups: { key: string; label: string; items: { title: unknown; value: unknown; raw: unknown }[] }[]
}
function KanbanView({
  data,
  onCellClick,
  inlineActions,
  groupBy,
  panelId,
  teamId,
  onDone,
  onError,
}: {
  data: KanbanShape
  onCellClick: ((raw: unknown) => void) | null
  inlineActions?: PanelAction[]
  groupBy?: string
  panelId?: string
  teamId?: string
  onDone?: () => void
  onError?: (msg: string) => void
}) {
  const clickable = !!onCellClick
  const [dragCard, setDragCard] = useState<{ raw: Record<string, unknown>; from: string } | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)

  // Pick the inline action that targets the kanban's group_by field.
  const moveAction =
    groupBy && inlineActions
      ? inlineActions.find((a) => (a.fields ?? []).includes(groupBy))
      : undefined
  const canDrag = !!(moveAction && panelId && teamId && groupBy)

  const handleDrop = async (toKey: string) => {
    if (!dragCard || !moveAction || !canDrag) return
    if (dragCard.from === toKey) {
      setDragCard(null)
      setHoverKey(null)
      return
    }
    const row = dragCard.raw
    const values: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        values[k] = v
      }
    }
    values[groupBy!] = toKey
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      await executePanelAction(panelId!, moveAction.id, teamId!, values)
      onDone?.()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setDragCard(null)
      setHoverKey(null)
    }
  }

  return (
    <div className="h-full flex gap-2 p-3 overflow-x-auto">
      {data.groups?.map((g) => {
        const isHover = hoverKey === g.key && dragCard && dragCard.from !== g.key
        return (
          <div
            key={g.key}
            onDragOver={(e) => {
              if (!canDrag) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (hoverKey !== g.key) setHoverKey(g.key)
            }}
            onDragLeave={() => setHoverKey((v) => (v === g.key ? null : v))}
            onDrop={(e) => {
              e.preventDefault()
              void handleDrop(g.key)
            }}
            className={clsx(
              'w-[200px] shrink-0 rounded-sm bg-neutral-50 dark:bg-neutral-900 border flex flex-col',
              isHover
                ? 'border-amber-400 ring-1 ring-amber-300'
                : 'border-neutral-200 dark:border-neutral-800',
            )}
          >
            <div className="px-2 py-1.5 text-[13px] font-medium text-neutral-600 dark:text-neutral-300 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800">
              <span className="truncate">{g.label}</span>
              <span className="text-neutral-400 font-mono">{g.items.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
              {g.items.length === 0 ? (
                <div className="text-[13px] text-neutral-300 text-center py-6">—</div>
              ) : (
                g.items.map((it, i) => {
                  const raw = it.raw as Record<string, unknown>
                  return (
                    <div
                      key={i}
                      draggable={canDrag}
                      onDragStart={(e) => {
                        if (!canDrag) return
                        e.dataTransfer.effectAllowed = 'move'
                        setDragCard({ raw, from: g.key })
                      }}
                      onDragEnd={() => {
                        setDragCard(null)
                        setHoverKey(null)
                      }}
                      onClick={clickable ? () => onCellClick!(it.raw) : undefined}
                      className={clsx(
                        'rounded-sm bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 p-2 hover:border-amber-300',
                        clickable && 'cursor-pointer',
                        canDrag && 'active:cursor-grabbing',
                        dragCard?.raw === raw && 'opacity-40',
                      )}
                    >
                      <div className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100 truncate">
                        {fmt(it.title)}
                      </div>
                      {it.value != null && (
                        <div className="text-[12px] text-neutral-500 font-mono mt-0.5">
                          {fmt(it.value)}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface ChartShape {
  x: string[]
  y: number[]
  series?: { name: string; data: number[] }[]
}
function ChartView({ data }: { data: ChartShape }) {
  const max = Math.max(1, ...(data.y ?? []))
  return (
    <div className="p-3 space-y-2">
      {(data.x ?? []).map((label, i) => {
        const v = data.y?.[i] ?? 0
        const pct = Math.round((v / max) * 100)
        return (
          <div key={label}>
            <div className="flex items-center justify-between text-[12.5px] text-neutral-500 mb-0.5">
              <span className="truncate">{label}</span>
              <span className="font-mono">{Intl.NumberFormat().format(v)}</span>
            </div>
            <div className="h-1.5 bg-neutral-100 dark:bg-neutral-800 rounded-sm overflow-hidden">
              <div
                className="h-full bg-amber-400"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface ListShape {
  items: { title: unknown; value: unknown; raw: unknown }[]
}
function ListView({
  data,
  onCellClick,
}: {
  data: ListShape
  onCellClick: ((raw: unknown) => void) | null
}) {
  if (!data.items?.length) {
    return <div className="p-4 text-[13px] text-neutral-400">(empty)</div>
  }
  const clickable = !!onCellClick
  return (
    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {data.items.map((it, i) => (
        <li
          key={i}
          onClick={clickable ? () => onCellClick!(it.raw) : undefined}
          className={
            'px-3 py-2 flex items-center justify-between gap-3 ' +
            (clickable ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50' : '')
          }
        >
          <span className="text-[13px] text-neutral-800 dark:text-neutral-100 truncate">
            {fmt(it.title)}
          </span>
          {it.value != null && (
            <span className="text-[12px] text-neutral-500 font-mono shrink-0">
              {fmt(it.value)}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------- detail modal ----------------------------------------------------

function DetailModal({ raw, onClose }: { raw: unknown; onClose: () => void }) {
  const entries = toEntries(raw)
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-md shadow-xl max-w-[560px] w-full max-h-[80vh] overflow-hidden flex flex-col border border-neutral-200 dark:border-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <div className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
            상세
          </div>
          <button
            onClick={onClose}
            className="text-[18px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 leading-none"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {entries.length === 0 ? (
            <pre className="text-[12px] font-mono text-neutral-500 whitespace-pre-wrap">
              {JSON.stringify(raw, null, 2)}
            </pre>
          ) : (
            <dl className="grid grid-cols-[140px_1fr] gap-y-2 gap-x-4 text-[13px]">
              {entries.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-neutral-500 truncate">{k}</dt>
                  <dd className="text-neutral-800 dark:text-neutral-100 font-mono break-all whitespace-pre-wrap">
                    {fmt(v)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- helpers ---------------------------------------------------------

function fmt(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') return Intl.NumberFormat().format(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function toEntries(raw: unknown): [string, unknown][] {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>)
  }
  return []
}

function pickPath(raw: unknown, path: string): unknown {
  if (raw == null || typeof raw !== 'object') return undefined
  let cur: unknown = raw
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
