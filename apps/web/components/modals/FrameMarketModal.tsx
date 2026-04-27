import {
  Buildings,
  CaretRight,
  ChartBar,
  CircleNotch,
  CloudSlash,
  DownloadSimple,
  Gauge,
  Kanban,
  MagnifyingGlass,
  CalendarBlank,
  Note,
  NotePencil,
  Package,
  Rows,
  Pulse,
  Robot,
  SquaresFour,
  Storefront,
  Table as TableIcon,
  Users as UsersIcon,
  Warning,
  X,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type React from 'react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { teamFromInstallResult } from '@/lib/api/frames'
import {
  type AiBindPreview,
  type MarketEntry,
  type MarketIndex,
  type MarketType,
  type PanelPreview,
  type PanelSize,
  aiBindPreview,
  applyPanelInstall,
  fetchMarketIndex,
  installMarketEntry,
} from '@/lib/api/market'
import { BindingCodeEditor } from '@/components/dashboard/BindingCodeEditor'
import { PanelShape } from '@/components/dashboard/BoundPanel'
import type { PanelAction, PanelBinding } from '@/lib/api/dashboards'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'

interface Props {
  open: boolean
  onClose: () => void
  /** Preselected target company for team/agent/panel installs. User can still
   *  switch to any other company via the dropdown inside the modal. */
  defaultCompanyId?: string | null
  /** Preselected target team for agent/panel installs. Only honoured if the team
   *  actually belongs to the preselected company. */
  defaultTeamId?: string | null
  /** Restrict visible tabs. Defaults to all four (company/team/agent/panel).
   *  When passed, the initial tab is the first entry in this list.
   *  If only one tab remains visible the tab bar is hidden. */
  allowedTabs?: MarketType[]
  /** Hide the "Install into" target picker. Install target is fixed to
   *  defaultCompanyId / defaultTeamId. Use when the invoking flow already
   *  implies a target (e.g. "New team" inside a specific company). */
  lockTarget?: boolean
  /** Fires after a panel frame has been appended to the target team's dashboard.
   *  Lets the caller refetch its dashboard layout. */
  onPanelInstalled?: () => void
}

type Span = 1 | 2 | 3 | 4 | 5 | 6
const SPANS: readonly Span[] = [1, 2, 3, 4, 5, 6]

const CATEGORY_BLURB: Record<string, string> = {
  kpi: 'Single-number tiles: totals, rates, streaks.',
  chart: 'Bar / line / stacked visualizations over a series.',
  table: 'Row-and-column views with sorting and filters.',
  kanban: 'Cards grouped by a status column, drag to move.',
  activity: 'Chronological feed of writes and events.',
  note: 'Pinned markdown — charters, links, reference text.',
  memo: 'Free-form sticky notes you write directly on the dashboard.',
  calendar: 'Month grid + day timetable for events on dated rows.',
  'stat-row': 'Compact horizontal row of related counters.',
}

const CATEGORY_ICON: Record<string, typeof UsersIcon> = {
  kpi: Gauge,
  chart: ChartBar,
  table: TableIcon,
  kanban: Kanban,
  activity: Pulse,
  note: Note,
  memo: NotePencil,
  calendar: CalendarBlank,
  'stat-row': Rows,
}

const TAB_DEFS: { type: MarketType; label: string; icon: typeof UsersIcon }[] = [
  { type: 'company', label: 'Companies', icon: Buildings },
  { type: 'team', label: 'Teams', icon: UsersIcon },
  { type: 'agent', label: 'Agents', icon: Robot },
  { type: 'panel', label: 'Panels', icon: SquaresFour },
]

export function FrameMarketModal({
  open,
  onClose,
  defaultCompanyId,
  defaultTeamId,
  allowedTabs,
  lockTarget,
  onPanelInstalled,
}: Props) {
  const t = useT()
  const companies = useAppStore((s) => s.companies)
  const addTeam = useAppStore((s) => s.addTeam)
  const visibleTabs = useMemo(
    () => TAB_DEFS.filter((d) => !allowedTabs || allowedTabs.includes(d.type)),
    [allowedTabs],
  )
  const [tab, setTab] = useState<MarketType>(allowedTabs?.[0] ?? 'team')
  useEffect(() => {
    if (allowedTabs && !allowedTabs.includes(tab)) {
      setTab(allowedTabs[0] ?? 'team')
    }
  }, [allowedTabs, tab])
  const [query, setQuery] = useState('')
  /** Panels tab only — 'all' or a specific category id. Cleared when the
   *  active tab is not 'panel' so switching tabs doesn't leak a filter. */
  const [panelCategory, setPanelCategory] = useState<string>('all')
  /** Non-null → the user drilled into an entry's detail/preview view.
   *  Clears when the tab, category, or search changes underneath them. */
  const [selectedEntry, setSelectedEntry] = useState<MarketEntry | null>(null)
  /** User-typed intent for what data the panel should bind to. Empty = AI
   *  picks something sensible (or sample tables when team is blank). */
  const [installIntent, setInstallIntent] = useState('')
  /** Result of the most recent "적용" (Apply) click — AI binding plus its
   *  shaped output for the live preview. Drives both the preview render and
   *  the install path (sent back to the server so the AI isn't re-invoked). */
  const [aiPreview, setAiPreview] = useState<AiBindPreview | null>(null)
  const [aiPreviewLoading, setAiPreviewLoading] = useState(false)
  const [aiPreviewError, setAiPreviewError] = useState<string | null>(null)
  /** Manual binding edit from the collapsible Code editor under "Data".
   *  Takes precedence over `aiPreview.binding` for both install and the
   *  live preview render so the user sees what their tweak produces. */
  const [bindingOverride, setBindingOverride] = useState<PanelBinding | null>(
    null,
  )
  const [previewDataOverride, setPreviewDataOverride] = useState<unknown>(null)
  /** User-chosen install size. Initialised to the frame's first declared
   *  size variant so the preview starts from a sensible default. */
  const [installColSpan, setInstallColSpan] = useState<Span>(2)
  const [installRowSpan, setInstallRowSpan] = useState<Span>(2)
  useEffect(() => {
    if (tab !== 'panel') setPanelCategory('all')
  }, [tab])
  // Leaving the list context (tab change, category change, new search) should
  // close the detail view — otherwise the user can end up looking at a panel's
  // detail page while the breadcrumb claims a different category.
  useEffect(() => {
    setSelectedEntry(null)
  }, [tab, panelCategory, query])
  // Reset the intent box whenever the user lands on a different entry — typed
  // intent for one panel should not leak into another.
  useEffect(() => {
    setInstallIntent('')
    setAiPreview(null)
    setAiPreviewError(null)
    setBindingOverride(null)
    setPreviewDataOverride(null)
    const firstSize = selectedEntry?.sizes?.[0]
    const clamp = (n: number | undefined): Span =>
      (Math.min(6, Math.max(1, n ?? 2)) as Span)
    setInstallColSpan(clamp(firstSize?.colSpan))
    setInstallRowSpan(clamp(firstSize?.rowSpan))
  }, [selectedEntry])
  const [index, setIndex] = useState<MarketIndex | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  /** Just-installed id → shows a transient "Installed ✓" affordance without
   *  locking the button — reinstalling is valid (team dupes are fine; two
   *  teams may legitimately need the same agent). Clears on entry change. */
  const [lastInstalled, setLastInstalled] = useState<string | null>(null)
  const [targetCompanyId, setTargetCompanyId] = useState<string | null>(
    defaultCompanyId ?? null,
  )
  const [targetTeamId, setTargetTeamId] = useState<string | null>(
    defaultTeamId ?? null,
  )

  useEscapeClose(open, onClose)
  // Close = full reset. Otherwise reopening lands on the last entry/detail
  // view the user was in — surprising, especially after an install flow.
  useEffect(() => {
    if (!open) {
      setSelectedEntry(null)
      setInstallError(null)
      setInstalling(null)
      setLastInstalled(null)
      setQuery('')
      setPanelCategory('all')
      setInstallIntent('')
      setAiPreview(null)
      setAiPreviewError(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setLoadError(null)
    fetchMarketIndex()
      .then((idx) => setIndex(idx))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [open])

  // When the modal opens, snap the target company to the parent's default.
  // Without this the modal retains whatever company was selected the first
  // time it mounted — so opening the picker from ExternalDB after an earlier
  // open from OpenHive would still install into OpenHive.
  useEffect(() => {
    if (!open) return
    if (defaultCompanyId) {
      setTargetCompanyId(defaultCompanyId)
    } else if (companies.length > 0) {
      setTargetCompanyId((prev) => prev ?? companies[0]!.id)
    }
    // Intentionally only re-runs when `open` flips or the parent's default
    // changes — not on every targetCompanyId edit, so the in-modal picker
    // (when lockTarget is false) still works.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultCompanyId])

  // Re-seed team target each time the company changes (or modal opens fresh).
  // Honour defaultTeamId only when it actually belongs to the current company;
  // otherwise fall back to the company's first team.
  useEffect(() => {
    if (!open) return
    if (!targetCompanyId) return
    const company = companies.find((c) => c.id === targetCompanyId)
    if (!company) return
    const defaultBelongs = company.teams.some((t) => t.id === defaultTeamId)
    if (defaultBelongs) {
      setTargetTeamId(defaultTeamId ?? null)
    } else if (targetTeamId && !company.teams.some((t) => t.id === targetTeamId)) {
      setTargetTeamId(company.teams[0]?.id ?? null)
    } else if (!targetTeamId) {
      setTargetTeamId(company.teams[0]?.id ?? null)
    }
  }, [open, companies, targetCompanyId, defaultTeamId, targetTeamId])

  const targetCompany = useMemo(
    () => companies.find((c) => c.id === targetCompanyId) ?? null,
    [companies, targetCompanyId],
  )
  const targetTeam = useMemo(
    () =>
      targetCompany?.teams.find((t) => t.id === targetTeamId) ??
      targetCompany?.teams[0] ??
      null,
    [targetCompany, targetTeamId],
  )

  /** Per-category counts for the panels tab chip row — derived from the full
   *  panel bucket (not query-filtered) so chip counts stay stable while the
   *  user types a search. */
  const panelCategories = useMemo<{ id: string; count: number }[]>(() => {
    const panels = index?.panels ?? []
    const counts = new Map<string, number>()
    for (const p of panels) {
      const cat = p.category ?? 'uncategorized'
      counts.set(cat, (counts.get(cat) ?? 0) + 1)
    }
    const order = ['kpi', 'chart', 'table', 'kanban', 'activity', 'note']
    const known = order
      .filter((k) => counts.has(k))
      .map((id) => ({ id, count: counts.get(id) ?? 0 }))
    const extras = Array.from(counts.keys())
      .filter((k) => !order.includes(k))
      .sort()
      .map((id) => ({ id, count: counts.get(id) ?? 0 }))
    return [{ id: 'all', count: panels.length }, ...known, ...extras]
  }, [index])

  const entries = useMemo<MarketEntry[]>(() => {
    if (!index) return []
    let bucket: MarketEntry[] =
      tab === 'company'
        ? index.companies
        : tab === 'team'
          ? index.teams
          : tab === 'agent'
            ? index.agents
            : index.panels
    if (tab === 'panel' && panelCategory !== 'all') {
      bucket = bucket.filter((e) => (e.category ?? 'uncategorized') === panelCategory)
    }
    if (!query.trim()) return bucket
    const q = query.trim().toLowerCase()
    return bucket.filter((e) => {
      const hay =
        `${e.name} ${e.description} ${(e.tags ?? []).join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }, [index, tab, query, panelCategory])

  if (!open) return null

  const onInstall = async (entry: MarketEntry) => {
    setInstallError(null)
    if (entry.type === 'company') {
      setInstallError('Company bundle install is coming soon.')
      return
    }
    if (!targetCompany) {
      setInstallError('먼저 회사를 만들어야 설치할 수 있어요.')
      return
    }
    if ((entry.type === 'agent' || entry.type === 'panel') && !targetTeam) {
      setInstallError('해당 회사에 팀이 없어요. 먼저 팀을 하나 만들어주세요.')
      return
    }

    // Panel installs are two-phase: fetch a preview first, then apply the
    // chosen plan. Non-panel types go straight through the legacy installer.
    if (entry.type === 'panel') {
      setInstalling(entry.id)
      const intent = installIntent.trim() ? installIntent.trim() : null
      try {
        // No more two-phase install. AI rebinding makes the deterministic
        // reuse/extend confirmation card moot — when AI runs (intent given
        // OR existing tables), it rewrites the binding to match the team's
        // schema; when AI doesn't run (blank team), there are no tables to
        // extend so standalone is always correct. Just apply directly.
        await applyPanelInstall({
          id: entry.id,
          category: entry.category ?? 'uncategorized',
          target_company_slug: targetCompany.slug,
          target_team_slug: targetTeam!.slug,
          target_team_id: targetTeam!.id,
          decision: 'standalone',
          alter_sql: [],
          skip_create_tables: [],
          user_intent: intent,
          prebuilt_binding:
            (bindingOverride as unknown as Record<string, unknown> | null) ??
            aiPreview?.binding ??
            null,
          // Pair the prebuilt binding with its setup_sql so install runs the
          // CREATE TABLE the user just previewed against. Skip when the
          // user hand-edited the binding via the Code editor — we can't
          // assume the original DDL still matches their changes.
          prebuilt_setup_sql:
            bindingOverride == null ? aiPreview?.setup_sql ?? null : null,
          col_span: installColSpan,
          row_span: installRowSpan,
        })
        onPanelInstalled?.()
        onClose()
      } catch (e) {
        setInstallError(e instanceof Error ? e.message : String(e))
      } finally {
        setInstalling(null)
      }
      return
    }

    setInstalling(entry.id)
    try {
      const result = await installMarketEntry({
        type: entry.type,
        id: entry.id,
        target_company_slug: targetCompany.slug,
        target_team_slug: entry.type === 'agent' ? targetTeam?.slug : undefined,
      })
      if (entry.type === 'team' && result.team) {
        addTeam(targetCompany.id, teamFromInstallResult(result.team))
      }
      setLastInstalled(entry.id)
      setTimeout(() => {
        setLastInstalled((cur) => (cur === entry.id ? null : cur))
      }, 2000)
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(null)
    }
  }

  const onApplyAiPreview = async (entry: MarketEntry) => {
    if (entry.type !== 'panel') return
    if (!targetCompany || !targetTeam) {
      setAiPreviewError(t('market.install.needTeam'))
      return
    }
    setAiPreviewLoading(true)
    setAiPreviewError(null)
    try {
      const res = await aiBindPreview({
        id: entry.id,
        category: entry.category ?? 'uncategorized',
        target_company_slug: targetCompany.slug,
        target_team_slug: targetTeam.slug,
        target_team_id: targetTeam.id,
        user_intent: installIntent.trim() ? installIntent.trim() : null,
      })
      setAiPreview(res)
      // Fresh AI binding supersedes any prior manual edit — clear overrides
      // so the Code editor re-syncs to the new binding text.
      setBindingOverride(null)
      setPreviewDataOverride(null)
      if (res.error) setAiPreviewError(res.error)
    } catch (e) {
      setAiPreviewError(e instanceof Error ? e.message : String(e))
      setAiPreview(null)
    } finally {
      setAiPreviewLoading(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Frame Market"
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
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <Storefront className="w-4 h-4 text-neutral-500" />
            <h2 className="text-base font-semibold">Frame Market</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        {/* Tabs + search + target picker — hidden while a detail/preview view
            is active. The detail view has its own back button, and the filter
            controls don't apply to a single entry. */}
        {!selectedEntry && (
        <div className="px-5 pt-3 pb-3 border-b border-neutral-100 dark:border-neutral-800 space-y-3">
          <div className="flex items-center gap-3">
            {visibleTabs.length > 1 && (
            <div className="inline-flex rounded border border-neutral-200 dark:border-neutral-700 p-0.5 text-[14px]">
              {visibleTabs.map(({ type, label, icon: Icon }) => {
                const active = tab === type
                const count = index
                  ? type === 'company'
                    ? index.companies.length
                    : type === 'team'
                      ? index.teams.length
                      : type === 'agent'
                        ? index.agents.length
                        : index.panels.length
                  : null
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setTab(type)}
                    className={clsx(
                      'px-3 py-1 rounded-sm inline-flex items-center gap-1.5',
                      active
                        ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                        : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                    {count !== null && (
                      <span
                        className={clsx(
                          'ml-0.5 text-[11px] font-mono',
                          active ? 'opacity-70' : 'text-neutral-400',
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            )}

            <div className="flex-1 relative">
              <MagnifyingGlass className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, tag, description…"
                className="w-full pl-8 pr-3 py-1.5 text-[14px] rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-300"
              />
            </div>
          </div>

          {/* Category breadcrumb — panels tab, after the user has drilled into
              a category. Lets them pop back to the category grid. */}
          {tab === 'panel' && panelCategory !== 'all' && (
            <div className="flex items-center gap-2 text-[13px]">
              <button
                type="button"
                onClick={() => setPanelCategory('all')}
                className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
              >
                ← All categories
              </button>
              <span className="text-neutral-300">/</span>
              <span className="font-medium text-neutral-800 dark:text-neutral-100">
                {panelCategory.toUpperCase()}
              </span>
            </div>
          )}

          {/* Install target pickers — only for team/agent/panel */}
          {tab !== 'company' && !lockTarget && (
            <div className="flex items-center gap-3 text-[13px] text-neutral-600 dark:text-neutral-300">
              <span className="text-neutral-500">Install into</span>
              <select
                value={targetCompanyId ?? ''}
                onChange={(e) => {
                  setTargetCompanyId(e.target.value || null)
                  setTargetTeamId(null)
                }}
                className="px-2 py-1 rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {(tab === 'agent' || tab === 'panel') && (
                <>
                  <span className="text-neutral-400">/</span>
                  <select
                    value={targetTeamId ?? targetTeam?.id ?? ''}
                    onChange={(e) => setTargetTeamId(e.target.value || null)}
                    className="px-2 py-1 rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800"
                  >
                    {(targetCompany?.teams ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                    {targetCompany && targetCompany.teams.length === 0 && (
                      <option value="">No teams — create one first</option>
                    )}
                  </select>
                </>
              )}
            </div>
          )}
        </div>
        )}

        {/* Body — panel detail uses a full-bleed split layout that mirrors
            the panel-edit modal. Everything else (lists, non-panel detail)
            stays in the padded single-column body. */}
        {selectedEntry?.type === 'panel' ? (
          <PanelDetailView
            entry={selectedEntry}
            justInstalled={lastInstalled === selectedEntry.id}
            isInstalling={installing === selectedEntry.id}
            canInstall={!!targetCompany && !!targetTeam}
            installIntent={installIntent}
            setInstallIntent={setInstallIntent}
            aiPreview={aiPreview}
            aiPreviewLoading={aiPreviewLoading}
            aiPreviewError={aiPreviewError}
            colSpan={installColSpan}
            rowSpan={installRowSpan}
            setColSpan={setInstallColSpan}
            setRowSpan={setInstallRowSpan}
            teamId={targetTeam?.id ?? null}
            bindingOverride={bindingOverride}
            setBindingOverride={setBindingOverride}
            previewDataOverride={previewDataOverride}
            setPreviewDataOverride={setPreviewDataOverride}
            onApplyAiPreview={() => onApplyAiPreview(selectedEntry)}
            onBack={() => setSelectedEntry(null)}
            onInstall={() => onInstall(selectedEntry)}
          />
        ) : (
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center gap-2 text-[14px] text-neutral-500">
              <CircleNotch className="w-4 h-4 animate-spin" />
              Fetching catalog…
            </div>
          )}

          {!loading && (loadError || (index?.warnings.length ?? 0) > 0) && (
            <div className="mb-4 rounded-md border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-[13px] text-amber-900 dark:text-amber-100 flex items-start gap-2">
              <CloudSlash className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <div className="font-medium">Catalog load failed</div>
                {loadError && <div className="font-mono text-[12px]">{loadError}</div>}
                {(index?.warnings ?? []).map((w) => (
                  <div key={w} className="font-mono text-[12px]">
                    {w}
                  </div>
                ))}
                <div className="text-amber-800 dark:text-amber-200">
                  Check that <code>packages/frame-market/</code> exists and
                  contains a valid <code>index.json</code>.
                </div>
              </div>
            </div>
          )}

          {/* Panels tab root view — category cards. User drills into a
              category before seeing individual panels. Bypassed when a search
              query is active (flattens results across all categories). */}
          {!loading &&
            tab === 'panel' &&
            panelCategory === 'all' &&
            !query.trim() && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {panelCategories
                  .filter((c) => c.id !== 'all')
                  .map(({ id, count }) => {
                    const Icon = CATEGORY_ICON[id] ?? Package
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setPanelCategory(id)}
                        className="text-left rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-4 hover:border-neutral-300 dark:hover:border-neutral-600 hover:shadow-sm transition-colors cursor-pointer"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300">
                              <Icon weight="regular" className="w-4 h-4" />
                            </span>
                            <div className="font-semibold text-[15px] text-neutral-900 dark:text-neutral-50 truncate">
                              {id.toUpperCase()}
                            </div>
                          </div>
                          <div className="font-mono text-[12px] text-neutral-400">
                            {count}
                          </div>
                        </div>
                        <div className="text-[12.5px] text-neutral-500 mt-1 leading-relaxed">
                          {CATEGORY_BLURB[id] ?? 'Panels in this category.'}
                        </div>
                      </button>
                    )
                  })}
              </div>
            )}

          {!loading && entries.length === 0 && !loadError &&
            !(tab === 'panel' && panelCategory === 'all' && !query.trim()) && (
            <div className="text-center py-16 text-neutral-400 text-[14px]">
              {query.trim()
                ? `No ${tab} frames match "${query}".`
                : `No ${tab} frames in the catalog yet.`}
            </div>
          )}

          {entries.length > 0 &&
            !(tab === 'panel' && panelCategory === 'all' && !query.trim()) &&
            !selectedEntry && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {entries.map((entry) => {
                const preview = entry.type === 'panel' ? entry.preview ?? null : null
                const meta =
                  entry.type === 'team' && entry.agent_count !== undefined
                    ? `${entry.agent_count} agent${entry.agent_count === 1 ? '' : 's'}`
                    : entry.type === 'company' && entry.teams
                      ? `${entry.teams.length} team${entry.teams.length === 1 ? '' : 's'}`
                      : entry.type === 'agent'
                        ? 'single agent'
                        : ''
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelectedEntry(entry)}
                    className="h-[150px] text-left rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-3.5 flex gap-4 hover:border-neutral-300 dark:hover:border-neutral-600 hover:shadow-sm transition-colors cursor-pointer overflow-hidden"
                  >
                    <div className="flex-1 min-w-0 flex flex-col">
                      <div className="font-semibold text-[14.5px] text-neutral-900 dark:text-neutral-50 truncate">
                        {entry.name}
                      </div>
                      {entry.author && (
                        <div className="text-[12px] text-neutral-400 font-mono truncate">
                          {entry.author}
                        </div>
                      )}
                      {entry.description && (
                        <p className="text-[13px] text-neutral-600 dark:text-neutral-300 mt-1.5 leading-relaxed line-clamp-3">
                          {entry.description}
                        </p>
                      )}
                      {meta && (
                        <div className="mt-auto pt-3 text-[12px] text-neutral-400">
                          {meta}
                        </div>
                      )}
                    </div>
                    {preview && (
                      <div className="shrink-0 w-[180px] hidden md:flex flex-col rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 overflow-hidden self-stretch">
                        <div className="flex-1 min-h-0 overflow-hidden">
                          {renderPreview(preview, true)}
                        </div>
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {/* Detail / preview view — whole body is replaced when an entry is
              selected. Install lives here, not on the list cards. */}
          {selectedEntry && (
            <EntryDetailView
              entry={selectedEntry}
              justInstalled={lastInstalled === selectedEntry.id}
              isInstalling={installing === selectedEntry.id}
              canInstall={
                selectedEntry.type !== 'company' &&
                !!targetCompany &&
                (selectedEntry.type !== 'agent' || !!targetTeam)
              }
              installIntent={installIntent}
              setInstallIntent={setInstallIntent}
              aiPreview={aiPreview}
              aiPreviewLoading={aiPreviewLoading}
              aiPreviewError={aiPreviewError}
              onApplyAiPreview={() => onApplyAiPreview(selectedEntry)}
              onBack={() => setSelectedEntry(null)}
              onInstall={() => onInstall(selectedEntry)}
            />
          )}
        </div>
        )}

        {/* Footer */}
        {installError && (
          <div className="border-t border-neutral-200 dark:border-neutral-800 px-5 py-2.5 bg-red-50 dark:bg-red-950/30 text-[13px] text-red-700 dark:text-red-200 flex items-start gap-2">
            <Warning className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="font-mono">{installError}</div>
          </div>
        )}
      </div>
    </div>
  )
}

function EntryDetailView({
  entry,
  justInstalled,
  isInstalling,
  canInstall,
  installIntent,
  setInstallIntent,
  aiPreview,
  aiPreviewLoading,
  aiPreviewError,
  onApplyAiPreview,
  onBack,
  onInstall,
}: {
  entry: MarketEntry
  justInstalled: boolean
  isInstalling: boolean
  canInstall: boolean
  installIntent: string
  setInstallIntent: (v: string) => void
  aiPreview: AiBindPreview | null
  aiPreviewLoading: boolean
  aiPreviewError: string | null
  onApplyAiPreview: () => void
  onBack: () => void
  onInstall: () => void
}) {
  const t = useT()
  const isCompany = entry.type === 'company'
  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-[13px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
      >
        ← Back
      </button>

      <div className="flex flex-col min-w-0">
        <div className="text-[11px] font-mono uppercase tracking-wide text-neutral-400">
          {entry.type}
          {entry.type === 'panel' && entry.category ? ` · ${entry.category}` : ''}
        </div>
        <div className="mt-0.5 text-[18px] font-semibold text-neutral-900 dark:text-neutral-50">
          {entry.name}
        </div>
        {entry.author && (
          <div className="text-[12px] text-neutral-400 font-mono mt-0.5">
            {entry.author}
          </div>
        )}
      </div>

      {entry.description && (
        <p className="text-[14px] leading-relaxed text-neutral-700 dark:text-neutral-200">
          {entry.description}
        </p>
      )}

      {entry.type === 'panel' && entry.category !== 'memo' && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="install-intent"
            className="text-[12px] text-neutral-500 dark:text-neutral-400"
          >
            {t('market.install.intentLabel')}
          </label>
          <div className="flex items-stretch gap-2">
            <textarea
              id="install-intent"
              value={installIntent}
              onChange={(e) => setInstallIntent(e.target.value)}
              placeholder={t('market.install.intentPlaceholder')}
              rows={2}
              className="flex-1 px-3 py-2 text-[13px] rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-300 resize-none"
            />
            <button
              type="button"
              onClick={onApplyAiPreview}
              disabled={aiPreviewLoading || isInstalling || !canInstall}
              className="shrink-0 self-stretch inline-flex items-center justify-center gap-1.5 px-3 text-[13px] rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {aiPreviewLoading ? (
                <CircleNotch className="w-3.5 h-3.5 animate-spin" />
              ) : null}
              {aiPreviewLoading
                ? t('market.install.applying')
                : t('market.install.apply')}
            </button>
          </div>
          {aiPreviewError && (
            <div className="text-[12px] text-red-600 dark:text-red-300 font-mono break-all">
              {aiPreviewError}
            </div>
          )}
        </div>
      )}

      {entry.type === 'panel' && (
        <PanelPreview entry={entry} aiPreview={aiPreview} />
      )}

      {((entry.type === 'team' && entry.agent_count !== undefined) ||
        (entry.type === 'company' && entry.teams)) && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
          {entry.type === 'team' && entry.agent_count !== undefined && (
            <DetailRow label="Agents" value={String(entry.agent_count)} />
          )}
          {entry.type === 'company' && entry.teams && (
            <DetailRow label="Bundled teams" value={entry.teams.join(', ')} />
          )}
        </dl>
      )}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={onInstall}
          disabled={isInstalling || aiPreviewLoading || isCompany || !canInstall}
          className={clsx(
            'inline-flex items-center gap-1.5 px-4 py-2 rounded-sm text-[13px] transition-colors',
            justInstalled
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-800'
              : isCompany
                ? 'bg-neutral-50 text-neutral-400 border border-neutral-200 dark:bg-neutral-800/60 dark:text-neutral-500 dark:border-neutral-700 cursor-not-allowed'
                : 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
          )}
        >
          {isInstalling ? (
            <CircleNotch className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <DownloadSimple className="w-3.5 h-3.5" />
          )}
          {isCompany
            ? 'Coming soon'
            : isInstalling
              ? 'Installing…'
              : justInstalled
                ? 'Installed ✓'
                : 'Install'}
        </button>
      </div>
    </div>
  )
}

/** Full-bleed split-pane view for panel-type entries. Left column = info +
 *  intent + Install footer; right column = live preview (cycles sample sizes
 *  until the user clicks Apply, then renders the AI-bound real data). */
function PanelDetailView({
  entry,
  justInstalled,
  isInstalling,
  canInstall,
  installIntent,
  setInstallIntent,
  aiPreview,
  aiPreviewLoading,
  aiPreviewError,
  colSpan,
  rowSpan,
  setColSpan,
  setRowSpan,
  teamId,
  bindingOverride,
  setBindingOverride,
  previewDataOverride,
  setPreviewDataOverride,
  onApplyAiPreview,
  onBack,
  onInstall,
}: {
  entry: MarketEntry
  justInstalled: boolean
  isInstalling: boolean
  canInstall: boolean
  installIntent: string
  setInstallIntent: (v: string) => void
  aiPreview: AiBindPreview | null
  aiPreviewLoading: boolean
  aiPreviewError: string | null
  colSpan: Span
  rowSpan: Span
  setColSpan: (v: Span) => void
  setRowSpan: (v: Span) => void
  teamId: string | null
  bindingOverride: PanelBinding | null
  setBindingOverride: (v: PanelBinding | null) => void
  previewDataOverride: unknown
  setPreviewDataOverride: (v: unknown) => void
  onApplyAiPreview: () => void
  onBack: () => void
  onInstall: () => void
}) {
  const t = useT()
  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      {/* Left column — info + controls */}
      <div className="w-[420px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-5 py-4">
            <button
              type="button"
              onClick={onBack}
              className="text-[13px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
            >
              ← Back
            </button>
          </div>

          <div className="px-5 pb-4 border-b border-neutral-100 dark:border-neutral-800">
            <div className="text-[18px] font-semibold text-neutral-900 dark:text-neutral-50">
              {entry.name}
            </div>
            {entry.author && (
              <div className="text-[12px] text-neutral-400 font-mono mt-0.5">
                {entry.author}
              </div>
            )}
            {entry.description && (
              <p className="mt-3 text-[13.5px] leading-relaxed text-neutral-700 dark:text-neutral-200">
                {entry.description}
              </p>
            )}
          </div>

          {/* Memo panels are content-only (no SQL / data binding), so the
              Data + Apply + Code controls don't apply — hide them so the
              install flow is just a one-click affair. */}
          {entry.category !== 'memo' && (
            <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
              <label
                htmlFor="install-intent"
                className="block text-[12px] font-medium text-neutral-500 dark:text-neutral-400 mb-1.5"
              >
                {t('panel.edit.data')}
              </label>
              <textarea
                id="install-intent"
                value={installIntent}
                onChange={(e) => setInstallIntent(e.target.value)}
                placeholder={t('market.install.intentPlaceholder')}
                rows={3}
                className="w-full px-3 py-2 text-[13px] rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-300 resize-none"
              />
              <button
                type="button"
                onClick={onApplyAiPreview}
                disabled={aiPreviewLoading || isInstalling || !canInstall}
                className="mt-2 w-full inline-flex items-center justify-center gap-1.5 h-8 px-4 text-[13px] rounded-sm bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                {aiPreviewLoading ? (
                  <CircleNotch className="w-3.5 h-3.5 animate-spin" />
                ) : null}
                {aiPreviewLoading
                  ? t('market.install.applying')
                  : t('market.install.apply')}
              </button>
              {aiPreviewError && (
                <div className="mt-2 text-[12px] text-red-600 dark:text-red-300 font-mono break-all">
                  {aiPreviewError}
                </div>
              )}
              <BindingCodeEditor
                binding={
                  bindingOverride ??
                  ((aiPreview?.binding as PanelBinding | undefined) ?? null)
                }
                panelType={aiPreview?.panel_type ?? entry.category ?? ''}
                teamId={teamId}
                onChange={setBindingOverride}
                onPreview={setPreviewDataOverride}
              />
            </div>
          )}

          <div className="px-5 py-4">
            <div className="block text-[12px] font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
              {t('panel.edit.size')}
            </div>
            <SizePicker
              label={t('panel.edit.width')}
              value={colSpan}
              onChange={setColSpan}
            />
            <div className="mt-2">
              <SizePicker
                label={t('panel.edit.height')}
                value={rowSpan}
                onChange={setRowSpan}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end px-5 py-3 border-t border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            onClick={onInstall}
            disabled={isInstalling || aiPreviewLoading || !canInstall}
            className={clsx(
              'inline-flex items-center gap-1.5 h-8 px-4 rounded-sm text-[13px] font-medium transition-colors',
              justInstalled
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-800'
                : 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
            )}
          >
            {isInstalling ? (
              <CircleNotch className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <DownloadSimple className="w-3.5 h-3.5" />
            )}
            {isInstalling ? 'Installing…' : justInstalled ? 'Installed ✓' : 'Install'}
          </button>
        </div>
      </div>

      {/* Right column — live preview, sized by the user-selected col/row. */}
      <div className="flex-1 min-w-0 bg-neutral-50 dark:bg-neutral-950 overflow-auto relative">
        <div className="min-h-full min-w-full flex items-center justify-center p-6">
          <PreviewCard
            entry={entry}
            aiPreview={aiPreview}
            previewDataOverride={previewDataOverride}
            colSpan={colSpan}
            rowSpan={rowSpan}
          />
        </div>
        {aiPreviewLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-50/50 dark:bg-neutral-950/50 pointer-events-none">
            <CircleNotch className="w-5 h-5 text-neutral-400 animate-spin" />
          </div>
        )}
      </div>
    </div>
  )
}

/** Same shape as the edit-modal preview: square cell unit, optional live data
 *  from the AI bind preview, sample render fallback. */
function PreviewCard({
  entry,
  aiPreview,
  previewDataOverride,
  colSpan,
  rowSpan,
}: {
  entry: MarketEntry
  aiPreview: AiBindPreview | null
  previewDataOverride?: unknown
  colSpan: Span
  rowSpan: Span
}) {
  const UNIT = 110
  const GAP = 12
  const preview = entry.preview
  // User's manual code edit (Run from BindingCodeEditor) takes precedence
  // over the AI bind preview, so the live render reflects what the override
  // binding produces — same precedence as install path.
  const liveData = previewDataOverride ?? aiPreview?.data
  const live = liveData != null
  return (
    <div
      className="flex flex-col rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-sm overflow-hidden transition-all shrink-0"
      style={{
        width: `${colSpan * UNIT + (colSpan - 1) * GAP}px`,
        height: `${rowSpan * UNIT + (rowSpan - 1) * GAP}px`,
      }}
    >
      <div className="shrink-0 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-700 text-[13px] font-medium text-neutral-700 dark:text-neutral-200 truncate">
        {entry.name}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {live ? (
          <PanelShape
            panelType={aiPreview?.panel_type ?? entry.category ?? ''}
            data={liveData}
            props={
              aiPreview?.panel_props ??
              propsFromPreview(entry.preview) ??
              undefined
            }
            groupBy={(() => {
              const m = (aiPreview?.binding as { map?: { group_by?: unknown } } | undefined)?.map
              return typeof m?.group_by === 'string' ? m.group_by : undefined
            })()}
            allActions={(() => {
              const a = (aiPreview?.binding as { actions?: unknown } | undefined)?.actions
              return Array.isArray(a) ? (a as PanelAction[]) : []
            })()}
          />
        ) : preview ? (
          renderPreview(preview)
        ) : (
          <div className="h-full flex items-center justify-center text-[12px] text-neutral-400">
            —
          </div>
        )}
      </div>
    </div>
  )
}

/** Recover the chart variant/layout/time-range hints from the catalog
 *  preview spec so a user-driven Run (Code editor) before Apply still renders
 *  in the panel's intended shape — without the catalog needing to ship the
 *  full panel.props blob. The AI bind preview, when present, already carries
 *  the authoritative panel_props and takes precedence. */
function propsFromPreview(
  p: PanelPreview | undefined,
): Record<string, unknown> | null {
  if (!p) return null
  switch (p.kind) {
    case 'pie':
      return { variant: 'pie' }
    case 'area':
      return { variant: 'area' }
    case 'line':
      return {
        variant: 'line',
        time_ranges: p.time_ranges,
        default_range: p.default_range,
      }
    case 'bar':
      return {
        variant: 'bar',
        layout: p.orientation === 'horizontal' ? 'horizontal' : 'vertical',
      }
    case 'heatmap':
      return { variant: 'heatmap' }
    case 'kpi':
      return p.tone ? { tone: p.tone } : {}
    case 'stat_row':
      return {}
    case 'calendar':
      return {}
    default:
      return null
  }
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-neutral-400">
        {label}
      </dt>
      <dd className="text-neutral-800 dark:text-neutral-100 truncate">
        {value}
      </dd>
    </div>
  )
}

// Scaled-down unit so every declared size fits inside the modal. Ratio
// roughly matches the dashboard grid (cols wider than rows).
const PREVIEW_UNIT_W = 140
const PREVIEW_UNIT_H = 80
const DEFAULT_PREVIEW_SIZE: PanelSize = { colSpan: 2, rowSpan: 2 }

/** Live preview of a panel frame, rendered with mocked data so the user can
 *  eyeball the UI before installing. Cycles through the size variants the
 *  frame author declared (`entry.sizes`); if the list is empty or missing,
 *  falls back to a single sensible default and hides the cycle button. */
function PanelPreview({
  entry,
  aiPreview,
}: {
  entry: MarketEntry
  aiPreview?: AiBindPreview | null
}) {
  const t = useT()
  const preview = entry.preview
  const sizes: PanelSize[] =
    entry.sizes && entry.sizes.length > 0 ? entry.sizes : [DEFAULT_PREVIEW_SIZE]
  const [sizeIndex, setSizeIndex] = useState(0)
  if (!preview && !aiPreview) return null
  const safeIndex = sizeIndex % sizes.length
  const size = sizes[safeIndex]!
  const cardWidth = size.colSpan * PREVIEW_UNIT_W
  const cardHeight = size.rowSpan * PREVIEW_UNIT_H
  // Live data from "적용" (AI bind preview) takes precedence — render the
  // shaped output via the same PanelShape used on the dashboard so the user
  // sees what the panel will actually look like with their data.
  const live = aiPreview && aiPreview.data != null
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11px] uppercase tracking-wide text-neutral-400">
          {live ? t('market.preview.live') : t('market.preview.sample')}
        </div>
        <div className="text-[11.5px] font-mono text-neutral-500">
          {size.colSpan} × {size.rowSpan}
          {sizes.length > 1 && (
            <span className="text-neutral-300 ml-1.5">
              ({safeIndex + 1}/{sizes.length})
            </span>
          )}
        </div>
      </div>
      <div className="flex items-stretch gap-3 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 p-4">
        <div className="flex-1 flex items-center justify-center min-h-[200px]">
          <div
            style={{
              width: `${cardWidth}px`,
              height: `${cardHeight}px`,
              maxWidth: '100%',
            }}
            className="flex flex-col rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-sm overflow-hidden transition-all"
          >
            <div className="shrink-0 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-700 text-[12.5px] font-medium text-neutral-700 dark:text-neutral-200 flex items-center justify-between">
              <span className="truncate">{entry.name}</span>
              {!live && preview?.subtitle && (
                <span className="shrink-0 ml-2 text-[11px] text-neutral-400">
                  {preview.subtitle}
                </span>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {live ? (
                <PanelShape
                  panelType={aiPreview.panel_type}
                  data={aiPreview.data}
                  groupBy={(() => {
                    const m = (aiPreview.binding as { map?: { group_by?: unknown } })?.map
                    return typeof m?.group_by === 'string' ? m.group_by : undefined
                  })()}
                  allActions={(() => {
                    const a = (aiPreview.binding as { actions?: unknown })?.actions
                    return Array.isArray(a) ? (a as PanelAction[]) : []
                  })()}
                />
              ) : preview ? (
                renderPreview(preview)
              ) : null}
            </div>
          </div>
        </div>
        {sizes.length > 1 && (
          <button
            type="button"
            onClick={() => setSizeIndex((i) => (i + 1) % sizes.length)}
            aria-label="Try next size"
            className="shrink-0 self-center w-9 h-9 rounded-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 flex items-center justify-center cursor-pointer shadow-sm"
          >
            <CaretRight weight="bold" className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}

function renderPreview(p: PanelPreview, compact = false): React.ReactElement {
  switch (p.kind) {
    case 'line':
      return (
        <LineChartPreview
          data={p.data}
          timeRanges={compact ? undefined : p.time_ranges}
          defaultRange={p.default_range}
        />
      )
    case 'area':
      return <AreaChartPreview data={p.data} />
    case 'bar':
      return <BarChartPreview bars={p.bars} format={p.format} orientation={p.orientation} compact={compact} />
    case 'pie':
      return <PieChartPreview slices={p.slices} compact={compact} />
    case 'kpi':
      return (
        <KpiPreview
          value={p.value}
          hint={p.hint}
          tone={p.tone}
          delta={p.delta}
          target={p.target}
          progress={p.progress}
          compact={compact}
        />
      )
    case 'kanban':
      return <KanbanPreview columns={p.columns} />
    case 'table':
      return <TablePreview columns={p.columns} rows={p.rows} />
    case 'heatmap':
      return (
        <HeatmapPreview
          rowLabels={p.rowLabels}
          colLabels={p.colLabels}
          values={p.values}
        />
      )
    case 'stat_row':
      return <StatRowPreview stats={p.stats} />
    case 'calendar':
      return <CalendarPreview month={p.month} days={p.days} />
    case 'memo':
      return <MemoPreview text={p.text} />
  }
}

function MemoPreview({ text }: { text: string }) {
  // Mirror the live MemoView shape: a stack of bordered note cards on a
  // plain panel background. Splits the sample text on blank lines so a
  // multi-paragraph preview reads as multiple cards (matching the real
  // multi-note panel UX).
  const cards = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return (
    <div className="h-full w-full p-1.5 bg-white dark:bg-neutral-900 flex flex-col gap-1.5 overflow-hidden">
      {cards.map((c, i) => (
        <div
          key={i}
          className="rounded-sm border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-1.5 text-[10px] leading-snug text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap"
        >
          {c}
        </div>
      ))}
    </div>
  )
}

function CalendarPreview({
  month,
  days,
}: {
  month: string
  days: { day: number; events?: number; today?: boolean; muted?: boolean }[]
}) {
  // Mirror the live CalendarView: month grid on the left + a slim detail
  // strip on the right with two mock event cards in the kind palette. Lets
  // catalog browsers see the split-pane shape at a glance.
  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 flex flex-col border-r border-neutral-200 dark:border-neutral-800">
        <div className="px-2 pt-1.5 text-[10px] text-neutral-500 font-medium tracking-wide truncate">
          {month}
        </div>
        <div className="flex-1 min-h-0 p-1.5">
          <div className="grid grid-cols-7 gap-px bg-neutral-200 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded-sm overflow-hidden h-full">
            {days.map((d, i) => (
              <div
                key={i}
                className={
                  d.today
                    ? 'bg-neutral-100 dark:bg-neutral-800 px-0.5 py-0.5 flex flex-col gap-0.5 items-stretch'
                    : 'bg-white dark:bg-neutral-900 px-0.5 py-0.5 flex flex-col gap-0.5 items-stretch'
                }
              >
                <div
                  className={
                    d.muted
                      ? 'text-[7.5px] text-neutral-300 dark:text-neutral-600 tabular-nums px-0.5'
                      : d.today
                        ? 'text-[7.5px] font-semibold text-neutral-900 dark:text-neutral-50 tabular-nums px-0.5'
                        : 'text-[7.5px] text-neutral-700 dark:text-neutral-300 tabular-nums px-0.5'
                  }
                >
                  {d.day}
                </div>
                {d.events && d.events > 0 && (
                  <div
                    className={
                      i % 3 === 0
                        ? 'h-[3px] rounded-sm bg-amber-400'
                        : i % 3 === 1
                          ? 'h-[3px] rounded-sm bg-blue-400'
                          : 'h-[3px] rounded-sm bg-violet-400'
                    }
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <CalendarPreviewDetail />
    </div>
  )
}

function CalendarPreviewDetail() {
  const t = useT()
  return (
    <div className="w-[42px] shrink-0 flex flex-col gap-1 p-1">
      <div className="text-[7.5px] text-neutral-400 truncate px-0.5">{t('calendar.preview.date')}</div>
      <div className="rounded-r-sm border border-l-[3px] border-l-amber-400 border-y-neutral-200 border-r-neutral-200 dark:border-y-neutral-700 dark:border-r-neutral-700 bg-white dark:bg-neutral-900 px-1 py-0.5">
        <div className="text-[7px] text-neutral-700 dark:text-neutral-200 truncate">{t('calendar.preview.event1')}</div>
      </div>
      <div className="rounded-r-sm border border-l-[3px] border-l-blue-400 border-y-neutral-200 border-r-neutral-200 dark:border-y-neutral-700 dark:border-r-neutral-700 bg-white dark:bg-neutral-900 px-1 py-0.5">
        <div className="text-[7px] text-neutral-700 dark:text-neutral-200 truncate">{t('calendar.preview.event2')}</div>
      </div>
      <div className="rounded-sm border border-dashed border-neutral-300 dark:border-neutral-600 px-1 py-0.5 text-[7px] text-neutral-400">
        + {t('calendar.add')}
      </div>
    </div>
  )
}

/** Compact catalog thumbnail for the stat-row frame. Mirrors the live
 *  StatRowView — divided cells, label-on-top + medium number — at a smaller
 *  scale that fits the catalog tile. */
function StatRowPreview({ stats }: { stats: { label: string; value: string }[] }) {
  if (stats.length === 0) return null
  return (
    <div className="h-full flex items-center px-2">
      <div className="flex w-full divide-x divide-neutral-200 dark:divide-neutral-800">
        {stats.map((s, i) => (
          <div key={`${s.label}-${i}`} className="flex-1 px-3 py-2.5 min-w-0">
            <div className="text-[10.5px] text-neutral-500 uppercase tracking-wider font-medium truncate">
              {s.label}
            </div>
            <div className="mt-1 text-[22px] font-semibold tracking-tight tabular-nums truncate">
              {formatPreviewValue(s.value, 'compact')}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Compact catalog thumbnail for the heatmap frame. Square cells in a CSS
 *  grid, monochrome neutral ramp keyed off the matrix max — same visual
 *  language as the live HeatmapView so what users see in the market matches
 *  what they install. */
function HeatmapPreview({
  rowLabels,
  colLabels,
  values,
}: {
  rowLabels: string[]
  colLabels: string[]
  values: number[][]
}) {
  let max = 0
  for (const row of values) for (const v of row) if (v > max) max = v
  const safeMax = max > 0 ? max : 1
  const cols = colLabels.length
  const rows = rowLabels.length
  return (
    <div className="h-full w-full p-2 flex items-center justify-center min-h-0 min-w-0 overflow-hidden">
      <div
        className="grid gap-[2px]"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          aspectRatio: `${cols} / ${rows}`,
          maxHeight: '100%',
          maxWidth: '100%',
          height: '100%',
          width: 'auto',
        }}
      >
        {rowLabels.map((rowLabel, ri) => (
          <Fragment key={rowLabel}>
            {colLabels.map((colLabel, ci) => {
              const v = values[ri]?.[ci] ?? 0
              const intensity = v / safeMax
              return (
                <div
                  key={colLabel}
                  className="rounded-[2px]"
                  style={{
                    background:
                      intensity > 0
                        ? `rgba(38,38,38,${(0.08 + intensity * 0.82).toFixed(3)})`
                        : 'rgba(0,0,0,0.04)',
                  }}
                />
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function KpiPreview({
  value,
  tone,
  delta,
  target,
  progress,
  compact,
}: {
  value: string
  /** No longer rendered — panel title carries the label. Kept on the prop
   *  list because PanelPreview type still defines `hint` for backwards
   *  compat with existing catalog entries. */
  hint?: string
  tone?: 'positive' | 'negative'
  delta?: string
  target?: string
  progress?: number
  /** Catalog-tile thumbnails set this — hides the unit toggle since the
   *  tile is too small for it to be useful. */
  compact?: boolean
}) {
  const t = useT()
  // Catalog preview's toggle is mostly a teaser — actual reformat only
  // happens for purely-numeric value strings ("1,234" → "1.2K"). Compact
  // strings like "₩7.2M" are passed through both modes since there's no
  // safe way to expand without losing fidelity.
  const [unitMode, setUnitMode] = useState<'compact' | 'full'>('compact')
  const formattedValue = formatPreviewValue(value, unitMode)
  const formattedTarget = target ? formatPreviewValue(target, unitMode) : undefined
  const deltaTone = (() => {
    if (!delta) return null
    if (/[▲↑+]/.test(delta)) return 'up'
    if (/[▼↓-]/.test(delta)) return 'down'
    return 'flat'
  })()
  return (
    <div className="h-full flex flex-col p-4">
      {!compact && (
        <div className="flex justify-end items-center gap-1">
          <button
            type="button"
            onClick={() => setUnitMode('compact')}
            aria-pressed={unitMode === 'compact'}
            className={
              unitMode === 'compact'
                ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
                : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
            }
          >
            {t('kpi.unit.compact')}
          </button>
          <button
            type="button"
            onClick={() => setUnitMode('full')}
            aria-pressed={unitMode === 'full'}
            className={
              unitMode === 'full'
                ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
                : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
            }
          >
            {t('kpi.unit.full')}
          </button>
        </div>
      )}
      <div className="flex-1 flex items-end min-w-0 w-full">
        <div className="min-w-0 w-full">
          <div
            className={clsx(
              'text-[26px] font-semibold tracking-tight truncate',
              tone === 'positive' && 'text-emerald-600 dark:text-emerald-400',
              tone === 'negative' && 'text-red-600 dark:text-red-400',
              !tone && 'text-neutral-900 dark:text-neutral-50',
            )}
          >
            {formattedValue}
            {formattedTarget && (
              <span className="text-[13px] font-normal text-neutral-400 ml-1.5">
                / {formattedTarget}
              </span>
            )}
            {delta && (
              <span
                className={clsx(
                  'text-[17px] font-medium font-mono ml-2',
                  deltaTone === 'up' && 'text-emerald-600 dark:text-emerald-400',
                  deltaTone === 'down' && 'text-red-600 dark:text-red-400',
                  deltaTone === 'flat' && 'text-neutral-500',
                )}
              >
                ({delta})
              </span>
            )}
          </div>
          {typeof progress === 'number' && (
            <div className="mt-2 w-full">
              <div className="h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                <div
                  className="h-full bg-neutral-800 dark:bg-neutral-200 rounded-full"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] font-mono text-neutral-500 tabular-nums">
                {progress.toFixed(0)}%
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Reformat the catalog's pre-baked KPI string for the toggle. Pulls the
 *  numeric portion out of "1,234" / "₩1,234" / "₩7.2M" / "142", reformats
 *  to compact (K/M/B/T) or full (locale grouped), preserves the symbol
 *  prefix. Strings we can't parse pass through unchanged so target labels
 *  like "$N/A" don't blow up. */
function formatPreviewValue(raw: string, mode: 'compact' | 'full'): string {
  const m = raw.match(/^(\D*)([\d,.]+)\s*([KMBT])?(\D*)$/)
  if (!m) return raw
  const [, prefix = '', numStr = '', suffix = '', tail = ''] = m
  const base = Number(numStr.replace(/,/g, ''))
  if (!Number.isFinite(base)) return raw
  const mult =
    suffix === 'K' ? 1e3 :
    suffix === 'M' ? 1e6 :
    suffix === 'B' ? 1e9 :
    suffix === 'T' ? 1e12 : 1
  const n = base * mult
  if (mode === 'full') {
    return `${prefix}${Intl.NumberFormat().format(Math.round(n))}${tail}`
  }
  const abs = Math.abs(n)
  const compact =
    abs >= 1e12 ? `${(n / 1e12).toFixed(1)}T` :
    abs >= 1e9 ? `${(n / 1e9).toFixed(1)}B` :
    abs >= 1e6 ? `${(n / 1e6).toFixed(1)}M` :
    abs >= 1e3 ? `${(n / 1e3).toFixed(1)}K` :
    Intl.NumberFormat().format(Math.round(n))
  return `${prefix}${compact}${tail}`
}

function LineChartPreview({
  data,
  timeRanges,
  defaultRange,
}: {
  data: number[]
  timeRanges?: number[]
  defaultRange?: number
}) {
  const ranges = (timeRanges ?? []).filter((n) => Number.isFinite(n) && n > 0)
  const fallback = ranges[ranges.length - 1] ?? null
  // Compact mode (no tabs): tail the array to a sensible window so the
  // thumbnail isn't a 90-point spaghetti — defaultRange wins, else 30.
  const compactWindow = ranges.length === 0 ? (defaultRange ?? 30) : null
  const init =
    defaultRange != null && ranges.includes(defaultRange) ? defaultRange : fallback
  const [range, setRange] = useState<number | null>(init)
  const effectiveRange = compactWindow ?? range
  const sliced = effectiveRange != null ? data.slice(-effectiveRange) : data
  const rows = sliced.map((y, i) => ({ x: i, y }))
  const tabs = ranges.length > 0 ? (
    <div className="px-2 pt-1.5 flex items-center justify-end gap-0.5">
      {ranges.map((n) => {
        const active = n === range
        return (
          <button
            key={n}
            type="button"
            onClick={() => setRange(n)}
            className={
              active
                ? 'px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
                : 'px-1.5 py-0.5 rounded-sm text-[10px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
            }
          >
            {n}d
          </button>
        )
      })}
    </div>
  ) : null
  const isCompact = ranges.length === 0
  return (
    <div className="h-full w-full flex flex-col text-neutral-400 dark:text-neutral-500">
      {tabs}
      <div className={isCompact ? 'flex-1 min-h-0 p-1' : 'flex-1 min-h-0 p-2'}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={isCompact ? { top: 4, right: 4, bottom: 0, left: 0 } : { top: 6, right: 6, bottom: 4, left: 0 }}>
            {!isCompact && (
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
            )}
            <XAxis
              dataKey="x"
              stroke="currentColor"
              tick={isCompact ? false : { fontSize: 9, fill: 'currentColor' }}
              tickLine={false}
              axisLine={isCompact ? false : { stroke: 'currentColor', strokeOpacity: 0.2 }}
              interval="preserveStartEnd"
              minTickGap={20}
              tickCount={3}
              hide={isCompact}
            />
            <YAxis
              stroke="currentColor"
              tick={isCompact ? false : { fontSize: 9, fill: 'currentColor' }}
              tickLine={false}
              axisLine={isCompact ? false : { stroke: 'currentColor', strokeOpacity: 0.2 }}
              width={isCompact ? 0 : 22}
              hide={isCompact}
            />
            <Tooltip
              cursor={{ stroke: 'currentColor', strokeOpacity: 0.2 }}
              contentStyle={{
                background: 'white',
                border: '1px solid rgb(229 229 229)',
                borderRadius: 4,
                fontSize: 11,
                padding: '4px 8px',
              }}
              labelFormatter={() => ''}
              formatter={(value) => [String(value), ''] as [string, string]}
              separator=""
              itemStyle={{ color: 'rgb(23 23 23)' }}
            />
            <Line
              type="monotone"
              dataKey="y"
              stroke="rgb(38 38 38)"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function BarChartPreview({
  bars,
  format,
  orientation,
  compact,
}: {
  bars: { label: string; value: number }[]
  format?: 'currency'
  orientation?: 'vertical' | 'horizontal'
  compact?: boolean
}) {
  const t = useT()
  const [mode, setMode] = useState<'count' | 'pct'>('count')
  const trimmed = collapsePreviewSlices(bars, MAX_PIE_SLICES).map(({ label, value }) => ({ label, value }))
  const total = trimmed.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0)
  const fmtNum = (v: number) => {
    if (mode === 'pct') return total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '0%'
    return format === 'currency' ? `$${v.toLocaleString()}` : Intl.NumberFormat().format(v)
  }
  const horizontal = orientation === 'horizontal'
  return (
    <div className="h-full w-full flex flex-col text-neutral-400 dark:text-neutral-500">
      {!compact && <ChartModeTabs mode={mode} setMode={setMode} tCount={t('chart.count')} tShare={t('chart.share')} />}
      <div className={compact ? 'flex-1 min-h-0 p-1' : 'flex-1 min-h-0 p-2 pt-0'}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={trimmed}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={compact ? { top: 4, right: 4, bottom: 4, left: 4 } : { top: 6, right: 6, bottom: 4, left: horizontal ? 4 : 0 }}
          >
            {!compact && (
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.15} vertical={horizontal} horizontal={!horizontal} />
            )}
            {horizontal ? (
              <>
                <XAxis type="number" stroke="currentColor" tick={compact ? false : { fontSize: 9, fill: 'currentColor' }} tickLine={false} axisLine={compact ? false : { stroke: 'currentColor', strokeOpacity: 0.2 }} tickFormatter={(v) => (typeof v === 'number' ? fmtNum(v) : String(v))} hide={compact} />
                <YAxis type="category" dataKey="label" stroke="currentColor" tick={compact ? false : { fontSize: 9, fill: 'currentColor' }} tickLine={false} axisLine={compact ? false : { stroke: 'currentColor', strokeOpacity: 0.2 }} width={compact ? 0 : 64} interval={0} hide={compact} />
              </>
            ) : (
              <>
                <XAxis dataKey="label" stroke="currentColor" tick={compact ? false : { fontSize: 10, fill: 'currentColor' }} tickLine={false} axisLine={compact ? false : { stroke: 'currentColor', strokeOpacity: 0.2 }} interval={0} hide={compact} />
                <YAxis stroke="currentColor" tick={compact ? false : { fontSize: 10, fill: 'currentColor' }} tickLine={false} axisLine={compact ? false : { stroke: 'currentColor', strokeOpacity: 0.2 }} width={compact ? 0 : (mode === 'pct' ? 36 : 28)} tickFormatter={(v) => (typeof v === 'number' ? fmtNum(v) : String(v))} hide={compact} />
              </>
            )}
            <Bar dataKey="value" fill="rgb(38 38 38)" radius={horizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]} maxBarSize={16} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ChartModeTabs({
  mode,
  setMode,
  tCount,
  tShare,
}: {
  mode: 'count' | 'pct'
  setMode: (m: 'count' | 'pct') => void
  tCount: string
  tShare: string
}) {
  return (
    <div className="px-2 pt-1.5 flex items-center justify-end gap-0.5">
      {([
        { id: 'count' as const, label: tCount },
        { id: 'pct' as const, label: tShare },
      ]).map(({ id, label }) => {
        const active = mode === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={
              active
                ? 'px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
                : 'px-1.5 py-0.5 rounded-sm text-[10px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
            }
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function AreaChartPreview({ data }: { data: number[] }) {
  const rows = data.map((y, i) => ({ x: i, y }))
  return (
    <div className="h-full w-full p-2 text-neutral-400 dark:text-neutral-500">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <Area type="monotone" dataKey="y" stroke="rgb(38 38 38)" strokeWidth={1.5} fill="rgb(38 38 38)" fillOpacity={0.15} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

const PIE_PREVIEW_PALETTE = [
  '#2563eb', '#f97316', '#16a34a', '#db2777', '#a855f7', '#eab308',
  '#0ea5e9', '#dc2626', '#14b8a6', '#8b5cf6', '#84cc16', '#64748b',
] as const

/** Up to 8 distinct slices + "기타" once we exceed 9. */
const MAX_PIE_SLICES = 9

function collapsePreviewSlices(
  slices: { label: string; value: number }[],
  max: number,
  otherLabel = 'Other',
): { label: string; value: number }[] {
  if (slices.length <= max) return slices
  const sorted = [...slices].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, max - 1)
  const tail = sorted.slice(max - 1)
  const sum = tail.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0)
  return [...head, { label: otherLabel, value: sum }]
}

function PieChartPreview({ slices, compact }: { slices: { label: string; value: number }[]; compact?: boolean }) {
  const t = useT()
  const [mode, setMode] = useState<'count' | 'pct'>('pct')
  const trimmed = collapsePreviewSlices(slices, MAX_PIE_SLICES, t('chart.other'))
  const total = trimmed.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0)
  const fmt = (v: number) =>
    mode === 'pct'
      ? total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '0%'
      : Intl.NumberFormat().format(v)
  return (
    <div className="h-full w-full flex flex-col text-neutral-400 dark:text-neutral-500">
      {!compact && <ChartModeTabs mode={mode} setMode={setMode} tCount={t('chart.count')} tShare={t('chart.share')} />}
      <div className={
        compact
          ? 'flex-1 min-h-0 p-1'
          : 'flex-1 min-h-0 p-2 pt-0 grid grid-cols-[1fr_auto] gap-1.5'
      }>
        <div className="min-w-0 h-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Pie data={trimmed} dataKey="value" nameKey="label" innerRadius="55%" outerRadius="85%" paddingAngle={0} stroke="none" isAnimationActive={false}>
                {trimmed.map((_, i) => (
                  <Cell key={i} fill={PIE_PREVIEW_PALETTE[i % PIE_PREVIEW_PALETTE.length]} stroke="none" />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        {!compact && (
          <ul className="self-end max-h-full overflow-y-auto pr-1 pb-1 space-y-0.5 text-[10px] leading-tight text-neutral-600 dark:text-neutral-300">
            {trimmed.map((s, i) => (
              <li key={`${s.label}-${i}`} className="flex items-center gap-1 min-w-0">
                <span className="shrink-0 inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: PIE_PREVIEW_PALETTE[i % PIE_PREVIEW_PALETTE.length] }} />
                <span className="truncate flex-1">{s.label}</span>
                <span className="shrink-0 text-neutral-400 font-mono">{fmt(s.value)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function KanbanPreview({
  columns,
}: {
  columns: { label: string; cards: string[] }[]
}) {
  return (
    <div className="h-full p-2 flex gap-1.5 overflow-hidden">
      {columns.map(({ label, cards }) => (
        <div
          key={label}
          className="flex-1 min-w-0 rounded-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 flex flex-col"
        >
          <div className="px-1.5 py-1 text-[11px] font-medium text-neutral-600 dark:text-neutral-300 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800">
            <span className="truncate">{label}</span>
            <span className="text-neutral-400 font-mono">{cards.length}</span>
          </div>
          <div className="flex-1 p-1 space-y-1 overflow-hidden">
            {cards.map((c) => (
              <div
                key={c}
                className="rounded-sm bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 px-1.5 py-1 text-[11px] text-neutral-700 dark:text-neutral-200 truncate"
              >
                {c}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TablePreview({
  columns,
  rows,
}: {
  columns: string[]
  rows: string[][]
}) {
  return (
    <div className="h-full overflow-hidden">
      <table className="w-full text-[11.5px]">
        <thead className="bg-neutral-50 dark:bg-neutral-900">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className="text-left font-medium text-neutral-500 px-2 py-1 border-b border-neutral-200 dark:border-neutral-800"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td
                  key={j}
                  className="px-2 py-1 border-b border-neutral-100 dark:border-neutral-800 text-neutral-700 dark:text-neutral-200 truncate"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
