import { AddPanelModal } from '@/components/dashboard/AddPanelModal'
import { AiEditDrawer } from '@/components/dashboard/AiEditDrawer'
import { Block } from '@/components/dashboard/Block'
import { BoundPanel } from '@/components/dashboard/BoundPanel'
import { DashboardAiDock } from '@/components/dashboard/DashboardAiDock'
import { HistoryModal } from '@/components/dashboard/HistoryModal'
import { RecipePickerModal } from '@/components/dashboard/RecipePickerModal'
import {
  type DashboardLayout,
  type PanelSpec,
  fetchDashboard,
  saveDashboard,
} from '@/lib/api/dashboards'
import { refreshPanel } from '@/lib/api/panels'
import { createSnapshot, discardSnapshot, restoreSnapshot } from '@/lib/api/snapshots'
import {
  type QueryResult,
  type SchemaResponse,
  fetchSchema,
  fetchTableRows,
} from '@/lib/api/teamData'
import { usePanelData } from '@/lib/hooks/usePanelData'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import {
  ChartBar,
  ClockCounterClockwise,
  Kanban,
  Note,
  Package,
  // Package is used both as icon and as recipe-picker trigger.
  PencilSimple,
  Plus,
  Sparkle,
  Table as TableIcon,
  TrendUp,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'

const STAGE_ORDER = ['prospect', 'qualified', 'proposal', 'won', 'lost'] as const
const STAGE_LABEL: Record<string, string> = {
  prospect: 'Prospect',
  qualified: 'Qualified',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
}

const DEFAULT_LAYOUT: DashboardLayout = { blocks: [] }

const ICON: Record<string, typeof TrendUp> = {
  kpi: TrendUp,
  table: TableIcon,
  kanban: Kanban,
  chart: ChartBar,
  activity: ClockCounterClockwise,
  note: Note,
}

export function Dashboard() {
  const t = useT()
  const teamId = useAppStore((s) => s.currentTeamId)
  const [schema, setSchema] = useState<SchemaResponse | null>(null)
  const [customers, setCustomers] = useState<QueryResult | null>(null)
  const [layout, setLayout] = useState<DashboardLayout | null>(null)
  const [editing, setEditing] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [addPanelOpen, setAddPanelOpen] = useState(false)
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [recipesOpen, setRecipesOpen] = useState(false)

  useEffect(() => {
    if (!teamId) return
    setSchema(null)
    setLayout(null)
    setCustomers(null)
    let cancelled = false
    fetchSchema(teamId)
      .then((s) => !cancelled && setSchema(s))
      .catch(() => !cancelled && setSchema({ tables: [], recent_migrations: [] }))
    fetchDashboard(teamId)
      .then((l) => !cancelled && setLayout(l ?? DEFAULT_LAYOUT))
      .catch(() => !cancelled && setLayout(DEFAULT_LAYOUT))
    return () => {
      cancelled = true
    }
  }, [teamId])

  useEffect(() => {
    if (!teamId) return
    if (!schema?.tables.some((tb) => tb.name === 'customer')) {
      setCustomers(null)
      return
    }
    let cancelled = false
    fetchTableRows(teamId, 'customer', 200)
      .then((r) => !cancelled && setCustomers(r))
      .catch(() => !cancelled && setCustomers(null))
    return () => {
      cancelled = true
    }
  }, [teamId, schema])

  const persist = useCallback(
    async (next: DashboardLayout) => {
      setLayout(next)
      if (teamId) await saveDashboard(teamId, next).catch(() => {})
    },
    [teamId],
  )

  const addBlock = useCallback(
    (spec: PanelSpec) => {
      const next = { blocks: [...(layout?.blocks ?? []), spec] }
      void persist(next)
    },
    [layout, persist],
  )

  const removeBlock = useCallback(
    (id: string) => {
      const next = { blocks: (layout?.blocks ?? []).filter((b) => b.id !== id) }
      void persist(next)
    },
    [layout, persist],
  )

  const updatePanel = useCallback(
    (spec: PanelSpec) => {
      const next = {
        blocks: (layout?.blocks ?? []).map((b) => (b.id === spec.id ? spec : b)),
      }
      void persist(next)
    },
    [layout, persist],
  )

  const reorderBlocks = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return
      const blocks = [...(layout?.blocks ?? [])]
      const from = blocks.findIndex((b) => b.id === sourceId)
      const to = blocks.findIndex((b) => b.id === targetId)
      if (from < 0 || to < 0) return
      const [moved] = blocks.splice(from, 1)
      blocks.splice(to, 0, moved!)
      void persist({ blocks })
    },
    [layout, persist],
  )

  const customerRows = customers?.rows ?? []
  const totalValue = customerRows.reduce(
    (acc, r) => acc + (typeof r.value === 'number' ? r.value : Number(r.value ?? 0)),
    0,
  )
  const byStage = STAGE_ORDER.map((stage) => ({
    stage,
    rows: customerRows.filter((r) => r.stage === stage),
  }))

  const enterEdit = useCallback(async () => {
    if (!teamId) return
    try {
      await createSnapshot(teamId)
    } catch {
      /* first-run — still allow editing */
    }
    setEditing(true)
  }, [teamId])

  const leaveEdit = useCallback(
    async (discard: boolean) => {
      setEditing(false)
      setAiOpen(false)
      if (!teamId) return
      if (discard) await discardSnapshot(teamId)
    },
    [teamId],
  )

  const onRestoreSnapshot = useCallback(async () => {
    if (!teamId) return
    await restoreSnapshot(teamId)
    const l = await fetchDashboard(teamId).catch(() => null)
    if (l) setLayout(l)
    const s = await fetchSchema(teamId).catch(() => null)
    if (s) setSchema(s)
    setAiOpen(false)
    setEditing(false)
  }, [teamId])

  const onApplyEdit = useCallback(async () => {
    if (!teamId) return
    await discardSnapshot(teamId)
    setAiOpen(false)
    setEditing(false)
  }, [teamId])

  return (
    <div className="h-full flex overflow-hidden bg-neutral-50 dark:bg-neutral-950">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 min-h-0 flex flex-col p-4">
          <div className="mb-3 flex items-center gap-2 shrink-0">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => setAddPanelOpen(true)}
                  className="h-9 pl-3 pr-3.5 rounded-full bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 text-[13px] font-medium inline-flex items-center gap-1.5 shadow-sm hover:opacity-90 cursor-pointer"
                >
                  <Plus weight="bold" className="w-3.5 h-3.5" />
                  {t('dashboard.addPanel')}
                </button>
                <button
                  type="button"
                  onClick={() => setRecipesOpen(true)}
                  className="h-9 px-3 rounded-full bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 text-[13px] font-medium text-neutral-700 dark:text-neutral-200 inline-flex items-center gap-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
                >
                  <Package className="w-3.5 h-3.5" />
                  {t('recipes.open')}
                </button>
                <div className="inline-flex items-center h-9 rounded-full bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setAiOpen((v) => !v)}
                    className={
                      aiOpen
                        ? 'h-full px-3 text-[13px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 inline-flex items-center gap-1.5 cursor-pointer'
                        : 'h-full px-3 text-[13px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 inline-flex items-center gap-1.5 cursor-pointer'
                    }
                  >
                    <Sparkle weight="fill" className="w-3.5 h-3.5 text-amber-500" />
                    {t('dashboard.aiCustomize')}
                  </button>
                  <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-800" />
                  <button
                    type="button"
                    onClick={() => setHistoryOpen(true)}
                    className="h-full px-3 text-[13px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <ClockCounterClockwise className="w-3.5 h-3.5" />
                    {t('history.open')}
                  </button>
                  <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-800" />
                  <button
                    type="button"
                    onClick={() => leaveEdit(true)}
                    className="h-full px-3 text-[13px] font-medium text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
                  >
                    {t('dashboard.done')}
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={enterEdit}
                className="h-9 pl-3 pr-3.5 rounded-full bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-[13px] font-medium inline-flex items-center gap-1.5 shadow-sm hover:opacity-90 cursor-pointer"
              >
                <PencilSimple className="w-3.5 h-3.5" />
                {t('dashboard.edit')}
              </button>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            {schema === null ? (
              <div className="h-full" aria-hidden="true" />
            ) : (layout?.blocks.length ?? 0) === 0 ? (
              editing ? (
                <EditEmptyState
                  onAdd={() => setAddPanelOpen(true)}
                  onAskAi={() => setAiOpen(true)}
                />
              ) : (
                <EmptyState />
              )
            ) : (
              <div className="grid grid-cols-4 auto-rows-[180px] gap-3 max-w-[1400px] mx-auto">
                {(layout?.blocks ?? []).map((spec) => (
                  <PanelCell
                    key={spec.id}
                    spec={spec}
                    editing={editing}
                    draggingId={draggingId}
                    dragOverId={dragOverId}
                    setDraggingId={setDraggingId}
                    setDragOverId={setDragOverId}
                    reorderBlocks={reorderBlocks}
                    removeBlock={removeBlock}
                    onEdit={() => setEditingPanelId(spec.id)}
                    customerRows={customerRows}
                    totalValue={totalValue}
                    byStage={byStage}
                    teamId={teamId}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {teamId && (
        <DashboardAiDock
          teamId={teamId}
          onApplied={async () => {
            const fresh = await fetchDashboard(teamId).catch(() => null)
            if (fresh) setLayout(fresh)
          }}
        />
      )}
      {recipesOpen && teamId && (
        <RecipePickerModal
          teamId={teamId}
          onClose={() => setRecipesOpen(false)}
          onInstalled={async () => {
            const fresh = await fetchDashboard(teamId).catch(() => null)
            if (fresh) setLayout(fresh)
          }}
        />
      )}
      {historyOpen && teamId && (
        <HistoryModal
          teamId={teamId}
          onClose={() => setHistoryOpen(false)}
          onRestored={async () => {
            const fresh = await fetchDashboard(teamId).catch(() => null)
            if (fresh) setLayout(fresh)
          }}
        />
      )}
      <AiEditDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onApply={onApplyEdit}
        onRestore={onRestoreSnapshot}
      />
      <AddPanelModal
        open={addPanelOpen}
        teamId={teamId}
        onClose={() => setAddPanelOpen(false)}
        onAdd={(spec) => {
          addBlock(spec)
          setAddPanelOpen(false)
        }}
      />
      <AddPanelModal
        open={editingPanelId !== null}
        teamId={teamId}
        existingSpec={
          editingPanelId ? (layout?.blocks.find((b) => b.id === editingPanelId) ?? null) : null
        }
        onClose={() => setEditingPanelId(null)}
        onAdd={() => {}}
        onUpdate={(spec) => {
          updatePanel(spec)
          setEditingPanelId(null)
        }}
      />
    </div>
  )
}

function PanelCell({
  spec,
  editing,
  draggingId,
  dragOverId,
  setDraggingId,
  setDragOverId,
  reorderBlocks,
  removeBlock,
  onEdit,
  customerRows,
  totalValue,
  byStage,
  teamId,
}: {
  spec: PanelSpec
  editing: boolean
  draggingId: string | null
  dragOverId: string | null
  setDraggingId: (id: string | null) => void
  setDragOverId: (id: string | null) => void
  reorderBlocks: (sourceId: string, targetId: string) => void
  removeBlock: (id: string) => void
  onEdit: () => void
  customerRows: Record<string, unknown>[]
  totalValue: number
  byStage: { stage: string; rows: Record<string, unknown>[] }[]
  teamId: string
}) {
  const Icon = ICON[spec.type] ?? TrendUp
  const live = usePanelData(spec.id, !!spec.binding)
  return (
    <Block
      id={spec.id}
      title={spec.title}
      subtitle={spec.subtitle}
      icon={<Icon className="w-3.5 h-3.5" />}
      colSpan={spec.colSpan ?? 1}
      rowSpan={spec.rowSpan ?? 1}
      editing={editing}
      dragging={draggingId === spec.id}
      dragOver={dragOverId === spec.id && draggingId !== spec.id}
      fetchedAt={spec.binding ? live.fetchedAt : null}
      liveError={spec.binding ? live.error : null}
      onRemove={() => removeBlock(spec.id)}
      onEdit={spec.binding ? onEdit : undefined}
      onRefresh={
        spec.binding
          ? async () => {
              await refreshPanel(spec.id).catch((e) => console.warn('refresh failed', e))
            }
          : undefined
      }
      onDragStart={(id, e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', id)
        setDraggingId(id)
      }}
      onDragOver={(id, e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dragOverId !== id) setDragOverId(id)
      }}
      onDragLeave={(id) => {
        if (dragOverId === id) setDragOverId(null)
      }}
      onDrop={(id, e) => {
        e.preventDefault()
        const src = draggingId ?? e.dataTransfer.getData('text/plain')
        if (src && src !== id) reorderBlocks(src, id)
        setDragOverId(null)
        setDraggingId(null)
      }}
      onDragEnd={() => {
        setDraggingId(null)
        setDragOverId(null)
      }}
    >
      {spec.binding ? (
        <BoundPanel spec={spec} teamId={teamId} />
      ) : (
        <BlockContent
          spec={spec}
          customerRows={customerRows}
          totalValue={totalValue}
          byStage={byStage}
        />
      )}
    </Block>
  )
}

function BlockContent({
  spec,
  customerRows,
  totalValue,
  byStage,
}: {
  spec: PanelSpec
  customerRows: Record<string, unknown>[]
  totalValue: number
  byStage: { stage: string; rows: Record<string, unknown>[] }[]
}) {
  const props = (spec.props ?? {}) as Record<string, unknown>
  switch (spec.type) {
    case 'kpi':
      return (
        <KpiContent
          value={kpiValue(String(props.metric ?? ''), { customerRows, totalValue })}
          hint={String(props.hint ?? '')}
        />
      )
    case 'kanban':
      return <KanbanContent byStage={byStage} />
    case 'table':
      return <CustomerTable rows={customerRows} />
    case 'chart':
      return <StageBars byStage={byStage} total={customerRows.length} />
    case 'activity':
      return (
        <div className="p-4 text-[14px] text-neutral-400">
          activity 테이블에 이벤트가 쌓이면 여기에 표시됩니다.
        </div>
      )
    case 'note':
      return (
        <div className="p-3 text-[14px] leading-relaxed text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap">
          {String(props.text ?? '')}
        </div>
      )
    default:
      return null
  }
}

function kpiValue(
  metric: string,
  ctx: { customerRows: Record<string, unknown>[]; totalValue: number },
): string {
  if (metric === 'total_customers') return String(ctx.customerRows.length)
  if (metric === 'pipeline_value') return `$${ctx.totalValue.toLocaleString()}`
  if (metric === 'win_rate') return `${winRate(ctx.customerRows)}%`
  if (metric === 'activity_today') return '0'
  return '—'
}

function winRate(rows: Record<string, unknown>[]): number {
  if (rows.length === 0) return 0
  const won = rows.filter((r) => r.stage === 'won').length
  return Math.round((won / rows.length) * 100)
}

function KpiContent({ value, hint }: { value: string; hint: string }) {
  return (
    <div className="h-full flex flex-col justify-between p-4">
      <div className="text-[14px] text-neutral-400">{hint}</div>
      <div className="text-[32px] font-semibold text-neutral-900 dark:text-neutral-100 tracking-tight">
        {value}
      </div>
    </div>
  )
}

function KanbanContent({
  byStage,
}: {
  byStage: { stage: string; rows: Record<string, unknown>[] }[]
}) {
  return (
    <div className="h-full flex gap-2 p-3 overflow-x-auto">
      {byStage.map(({ stage, rows }) => (
        <div
          key={stage}
          className="w-[200px] shrink-0 rounded-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 flex flex-col"
        >
          <div className="px-2 py-1.5 text-[14px] font-medium text-neutral-600 dark:text-neutral-300 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800">
            <span>{STAGE_LABEL[stage] ?? stage}</span>
            <span className="text-neutral-400 font-mono">{rows.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
            {rows.length === 0 ? (
              <div className="text-[14px] text-neutral-300 text-center py-6">—</div>
            ) : (
              rows.map((r) => (
                <div
                  key={String(r.id)}
                  className="rounded-sm bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 p-2 hover:border-amber-300 cursor-pointer"
                >
                  <div className="text-[14px] font-medium text-neutral-800 dark:text-neutral-100 truncate">
                    {String(r.name ?? '—')}
                  </div>
                  <div className="text-[14px] text-neutral-500 font-mono mt-0.5">
                    ${Number(r.value ?? 0).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function CustomerTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return (
      <div className="p-4 text-[14px] text-neutral-400">
        아직 고객이 없습니다. 채팅에서 "Foo Bar 고객 추가해"처럼 말하면 에이전트가 기록합니다.
      </div>
    )
  }
  return (
    <table className="w-full text-[14px]">
      <thead className="bg-neutral-50 dark:bg-neutral-900 sticky top-0">
        <tr>
          {['name', 'email', 'stage', 'value', 'owner'].map((c) => (
            <th
              key={c}
              className="text-left font-medium text-neutral-500 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
            <td className="px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 text-neutral-800 dark:text-neutral-100">
              {String(r.name ?? '')}
            </td>
            <td className="px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 text-neutral-500 font-mono">
              {String(r.email ?? '')}
            </td>
            <td className="px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800">
              <span className="inline-block px-1.5 py-0.5 rounded-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 text-[14px] capitalize">
                {String(r.stage ?? '')}
              </span>
            </td>
            <td className="px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 text-neutral-800 dark:text-neutral-100 font-mono">
              ${Number(r.value ?? 0).toLocaleString()}
            </td>
            <td className="px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 text-neutral-500">
              {String(r.owner ?? '—')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StageBars({
  byStage,
  total,
}: {
  byStage: { stage: string; rows: Record<string, unknown>[] }[]
  total: number
}) {
  return (
    <div className="p-3 space-y-2">
      {byStage.map(({ stage, rows }) => {
        const pct = total > 0 ? Math.round((rows.length / total) * 100) : 0
        return (
          <div key={stage}>
            <div className="flex items-center justify-between text-[14px] text-neutral-500 mb-0.5">
              <span className="capitalize">{STAGE_LABEL[stage] ?? stage}</span>
              <span className="font-mono">
                {rows.length} · {pct}%
              </span>
            </div>
            <div className="h-1.5 bg-neutral-100 dark:bg-neutral-800 rounded-sm overflow-hidden">
              <div className="h-full bg-amber-400" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EmptyState() {
  const t = useT()
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-[460px] text-center">
        <div className="mx-auto w-12 h-12 rounded-md bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 flex items-center justify-center mb-3">
          <Package className="w-5 h-5 text-neutral-500" />
        </div>
        <div className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
          {t('dashboard.empty.title')}
        </div>
        <p className="text-[14px] text-neutral-500 mt-1 leading-relaxed">
          {t('dashboard.empty.desc')}
        </p>
      </div>
    </div>
  )
}

function EditEmptyState({
  onAdd,
  onAskAi,
}: {
  onAdd: () => void
  onAskAi: () => void
}) {
  const t = useT()
  return (
    <div className="h-full max-w-[1400px] mx-auto">
      <div
        role="button"
        tabIndex={0}
        onClick={onAdd}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onAdd()
          }
        }}
        className="group relative h-full rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-600 bg-white/40 dark:bg-neutral-900/30 hover:bg-white/70 dark:hover:bg-neutral-900/50 transition-colors cursor-pointer flex flex-col items-center justify-center gap-6 p-10 overflow-hidden"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(0,0,0,0.06) 1px, transparent 0)',
          backgroundSize: '18px 18px',
        }}
      >
        <div className="w-14 h-14 rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] flex items-center justify-center transition-transform group-hover:-translate-y-0.5">
          <Plus weight="bold" className="w-6 h-6 text-neutral-700 dark:text-neutral-200" />
        </div>
        <div className="text-center">
          <div className="text-[16px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {t('dashboard.emptyEdit.title')}
          </div>
          <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mt-1.5 max-w-[380px] mx-auto leading-relaxed">
            {t('dashboard.emptyEdit.desc')}
          </p>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onAskAi()
          }}
          className="h-8 px-3 rounded-full bg-white dark:bg-neutral-900 ring-1 ring-amber-300/70 dark:ring-amber-400/30 text-[13px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 inline-flex items-center gap-1.5 cursor-pointer shadow-sm"
        >
          <Sparkle weight="fill" className="w-3.5 h-3.5 text-amber-500" />
          {t('dashboard.emptyEdit.askAi')}
        </button>
      </div>
    </div>
  )
}
