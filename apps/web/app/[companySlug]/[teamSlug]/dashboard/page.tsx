'use client'

import {
  ChartBar,
  ChatCircleText,
  ClockCounterClockwise,
  CurrencyDollar,
  Kanban,
  Note,
  Package,
  PencilSimple,
  Sparkle,
  Table as TableIcon,
  TrendUp,
  Users,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { AddPanelModal } from '@/components/dashboard/AddPanelModal'
import { AiEditDrawer } from '@/components/dashboard/AiEditDrawer'
import { Block } from '@/components/dashboard/Block'
import { BoundPanel } from '@/components/dashboard/BoundPanel'
import { refreshPanel } from '@/lib/api/panels'
import { usePanelData } from '@/lib/hooks/usePanelData'
import {
  fetchDashboard,
  saveDashboard,
  type PanelSpec,
  type DashboardLayout,
} from '@/lib/api/dashboards'
import {
  createSnapshot,
  discardSnapshot,
  restoreSnapshot,
} from '@/lib/api/snapshots'
import {
  fetchSchema,
  fetchTableRows,
  installTemplate,
  type QueryResult,
  type SchemaResponse,
} from '@/lib/api/teamData'
import { useAppStore } from '@/lib/stores/useAppStore'

const STAGE_ORDER = ['prospect', 'qualified', 'proposal', 'won', 'lost'] as const
const STAGE_LABEL: Record<string, string> = {
  prospect: 'Prospect',
  qualified: 'Qualified',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
}

const DEFAULT_LAYOUT: DashboardLayout = {
  blocks: [
    { id: 'kpi-customers', type: 'kpi', title: 'Total customers', colSpan: 1, rowSpan: 1, props: { metric: 'total_customers', hint: '활성 고객 레코드' } },
    { id: 'kpi-pipeline', type: 'kpi', title: 'Pipeline value', colSpan: 1, rowSpan: 1, props: { metric: 'pipeline_value', hint: '열린 거래 합계' } },
    { id: 'kpi-win', type: 'kpi', title: 'Win rate', colSpan: 1, rowSpan: 1, props: { metric: 'win_rate', hint: '지난 분기 기준' } },
    { id: 'kpi-activity', type: 'kpi', title: 'Activity today', colSpan: 1, rowSpan: 1, props: { metric: 'activity_today', hint: '에이전트 + 사용자 이벤트' } },
    { id: 'kanban-pipe', type: 'kanban', title: 'Sales pipeline', subtitle: 'stage별 고객', colSpan: 3, rowSpan: 2, props: { table: 'customer', groupBy: 'stage' } },
    { id: 'note-team', type: 'note', title: 'Quick note', colSpan: 1, rowSpan: 2, props: { text: '이 블록은 팀 메모용입니다.\n\n• 이번 주 목표: 신규 리드 10건\n• 집중 고객: Acme Corp\n• 차주 미팅: —\n\n(자유 편집 · 마크다운 대응 예정)' } },
    { id: 'table-cust', type: 'table', title: 'Customers', colSpan: 3, rowSpan: 1, props: { table: 'customer' } },
    { id: 'chart-stage', type: 'chart', title: 'Stage distribution', colSpan: 1, rowSpan: 1, props: { table: 'customer', groupBy: 'stage', kind: 'bars' } },
    { id: 'activity-feed', type: 'activity', title: 'Recent activity', colSpan: 4, rowSpan: 1, props: {} },
  ],
}

const ICON: Record<string, typeof TrendUp> = {
  kpi: TrendUp,
  table: TableIcon,
  kanban: Kanban,
  chart: ChartBar,
  activity: ClockCounterClockwise,
  note: Note,
}

export default function DashboardPage() {
  const teamId = useAppStore((s) => s.currentTeamId)
  const [schema, setSchema] = useState<SchemaResponse | null>(null)
  const [customers, setCustomers] = useState<QueryResult | null>(null)
  const [installing, setInstalling] = useState(false)
  const [layout, setLayout] = useState<DashboardLayout | null>(null)
  const [editing, setEditing] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [addPanelOpen, setAddPanelOpen] = useState(false)
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null)

  useEffect(() => {
    if (!teamId) return
    // Clear any stale state from the previous team — without this the old team's
    // schema/layout/rows flash on screen until the new fetches resolve.
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
    if (!schema?.tables.some((t) => t.name === 'customer')) {
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

  const hasTemplate = !!schema?.tables.some((t) => t.name === 'customer')
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
      // If snapshot fails (e.g. first run), still allow edit mode — user choice.
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

  async function onInstallCrm() {
    if (!teamId) return
    setInstalling(true)
    try {
      await installTemplate(teamId, 'crm')
      const s = await fetchSchema(teamId)
      setSchema(s)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="h-full flex overflow-hidden bg-neutral-50 dark:bg-neutral-950">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-auto p-4">
        <div className="max-w-[1400px] mx-auto mb-3 flex items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => setAddPanelOpen(true)}
                className="h-9 px-3 rounded-sm bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 text-[14px] font-medium flex items-center gap-1.5 hover:opacity-90 cursor-pointer"
              >
                + 패널 추가
              </button>
              <button
                type="button"
                onClick={() => setAiOpen((v) => !v)}
                className={
                  aiOpen
                    ? 'h-9 px-3 rounded-sm bg-amber-500 text-white text-[14px] font-medium flex items-center gap-1.5 cursor-pointer'
                    : 'h-9 px-3 rounded-sm border border-amber-400 text-amber-600 dark:text-amber-300 text-[14px] font-medium flex items-center gap-1.5 hover:bg-amber-50 dark:hover:bg-amber-950/40 cursor-pointer'
                }
              >
                <Sparkle weight="fill" className="w-3.5 h-3.5" />
                커스터마이즈
              </button>
              <button
                type="button"
                onClick={() => leaveEdit(true)}
                className="h-9 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-[14px] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
              >
                완료
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={enterEdit}
              className="h-9 px-3 rounded-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-[14px] font-medium flex items-center gap-1.5 hover:opacity-90 cursor-pointer"
            >
              <PencilSimple className="w-3.5 h-3.5" />
              편집
            </button>
          )}
        </div>

        {schema === null ? (
          // Loading: render nothing rather than flash EmptyState before we know
          // whether this team actually has a populated dashboard.
          <div className="h-full" aria-hidden="true" />
        ) : !hasTemplate ? (
          <EmptyState onInstall={onInstallCrm} installing={installing} />
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
              />
            ))}
          </div>
        )}
        </div>
      </div>
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
          editingPanelId
            ? layout?.blocks.find((b) => b.id === editingPanelId) ?? null
            : null
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

/** Wraps the drag-and-drop Block shell + dispatches content:
 *  - `spec.binding` set → BoundPanel (lives off block_cache, shows "live" chip)
 *  - legacy path       → BlockContent (hard-coded CRM defaults for backwards compat)
 */
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
}) {
  const Icon = ICON[spec.type] ?? TrendUp
  // Only subscribe to the cache when this panel has a binding. Keeps SSE
  // connections down to "one per live panel".
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
              await refreshPanel(spec.id).catch((e) =>
                console.warn('refresh failed', e),
              )
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
        <BoundPanel spec={spec} />
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

function EmptyState({ onInstall, installing }: { onInstall: () => void; installing: boolean }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-[460px] text-center">
        <div className="mx-auto w-12 h-12 rounded-md bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 flex items-center justify-center mb-3">
          <Package className="w-5 h-5 text-neutral-500" />
        </div>
        <div className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
          이 팀의 대시보드가 비어있어요
        </div>
        <p className="text-[14px] text-neutral-500 mt-1 leading-relaxed">
          블록을 직접 추가하거나, 도메인 템플릿을 설치해 기본 레이아웃을 불러올 수 있습니다. 블록은
          자유롭게 배치 가능하며 템플릿에서 꺼낸 블록도 이후 편집할 수 있습니다.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            className="h-8 px-3 rounded-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            {installing ? 'Installing…' : 'CRM 템플릿 설치'}
          </button>
          <button
            type="button"
            className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 text-[14px] font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
          >
            빈 블록부터 시작
          </button>
        </div>
      </div>
    </div>
  )
}
