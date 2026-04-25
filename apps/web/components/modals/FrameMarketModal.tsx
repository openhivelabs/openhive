import {
  Buildings,
  CaretRight,
  CircleNotch,
  CloudSlash,
  DownloadSimple,
  MagnifyingGlass,
  Package,
  Robot,
  SquaresFour,
  Users as UsersIcon,
  Warning,
  X,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { teamFromInstallResult } from '@/lib/api/frames'
import {
  type InstallPlan,
  type MarketEntry,
  type MarketIndex,
  type MarketType,
  type PanelInstallPreview,
  type PanelSize,
  applyPanelInstall,
  fetchMarketIndex,
  installMarketEntry,
  previewPanelInstall,
} from '@/lib/api/market'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
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

const CATEGORY_BLURB: Record<string, string> = {
  kpi: 'Single-number tiles: totals, rates, streaks.',
  chart: 'Bar / line / stacked visualizations over a series.',
  table: 'Row-and-column views with sorting and filters.',
  kanban: 'Cards grouped by a status column, drag to move.',
  activity: 'Chronological feed of writes and events.',
  note: 'Pinned markdown — charters, links, reference text.',
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
  /** Panel install is two-phase. When the user clicks Install on a panel
   *  detail, we fetch a preview first. `reuse`/`extend` → confirmation
   *  card; `standalone` → auto-apply. */
  const [panelPreview, setPanelPreview] = useState<PanelInstallPreview | null>(
    null,
  )
  useEffect(() => {
    if (tab !== 'panel') setPanelCategory('all')
  }, [tab])
  // Leaving the list context (tab change, category change, new search) should
  // close the detail view — otherwise the user can end up looking at a panel's
  // detail page while the breadcrumb claims a different category.
  useEffect(() => {
    setSelectedEntry(null)
  }, [tab, panelCategory, query])
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
      setPanelPreview(null)
      setInstallError(null)
      setInstalling(null)
      setLastInstalled(null)
      setQuery('')
      setPanelCategory('all')
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

  useEffect(() => {
    if (!open) return
    if (!targetCompanyId && companies.length > 0) {
      setTargetCompanyId(defaultCompanyId ?? companies[0]!.id)
    }
  }, [open, companies, defaultCompanyId, targetCompanyId])

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
      try {
        const preview = await previewPanelInstall({
          id: entry.id,
          category: entry.category ?? 'uncategorized',
          target_company_slug: targetCompany.slug,
          target_team_slug: targetTeam!.slug,
          target_team_id: targetTeam!.id,
        })
        // Auto-apply when the plan has zero decisions to present: either
        // standalone (nothing to confirm) or high-confidence reuse with no
        // ALTERs. This keeps the happy path one-click.
        if (preview.plan.decision === 'standalone') {
          await applyChosenPanelPlan(entry, preview, preview.plan.decision)
          return
        }
        // Reuse / extend — show confirmation card. User picks Connect
        // (recommended) or Keep separate.
        setPanelPreview(preview)
      } catch (e) {
        setInstallError(e instanceof Error ? e.message : String(e))
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

  /** Shared apply path used by both auto-apply (standalone) and the
   *  user-confirmed Connect/Keep-separate buttons. */
  const applyChosenPanelPlan = async (
    entry: MarketEntry,
    preview: PanelInstallPreview,
    decision: InstallPlan['decision'],
  ) => {
    if (!targetCompany || !targetTeam) return
    try {
      await applyPanelInstall({
        id: entry.id,
        category: entry.category ?? 'uncategorized',
        target_company_slug: targetCompany.slug,
        target_team_slug: targetTeam.slug,
        target_team_id: targetTeam.id,
        decision,
        // Only send ALTERs when the user actually chose extend.
        alter_sql: decision === 'extend' ? preview.plan.alter_sql : [],
        skip_create_tables:
          decision === 'reuse' || decision === 'extend'
            ? preview.plan.skip_create_tables
            : [],
      })
      onPanelInstalled?.()
      setLastInstalled(entry.id)
      setTimeout(() => {
        setLastInstalled((cur) => (cur === entry.id ? null : cur))
      }, 2000)
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e))
    } finally {
      setPanelPreview(null)
      setInstalling(null)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Frame Market"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[860px] max-w-[96vw] h-[78vh] max-h-[720px] rounded-md bg-white dark:bg-neutral-900 shadow-xl border border-neutral-200 dark:border-neutral-800 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-neutral-500" />
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
              <span className="capitalize font-medium text-neutral-800 dark:text-neutral-100">
                {panelCategory}
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

        {/* Body */}
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
                <div className="font-medium">Market unreachable</div>
                {loadError && <div className="font-mono text-[12px]">{loadError}</div>}
                {(index?.warnings ?? []).map((w) => (
                  <div key={w} className="font-mono text-[12px]">
                    {w}
                  </div>
                ))}
                <div className="text-amber-800 dark:text-amber-200">
                  Set <code>OPENHIVE_MARKET_BASE_URL</code> to point at a
                  different GitHub raw URL if you host your own catalog.
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {panelCategories
                  .filter((c) => c.id !== 'all')
                  .map(({ id, count }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPanelCategory(id)}
                      className="text-left rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-4 hover:border-neutral-300 dark:hover:border-neutral-600 hover:shadow-sm transition-colors cursor-pointer"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-[15px] text-neutral-900 dark:text-neutral-50 capitalize">
                          {id}
                        </div>
                        <div className="font-mono text-[12px] text-neutral-400">
                          {count}
                        </div>
                      </div>
                      <div className="text-[12.5px] text-neutral-500 mt-1 leading-relaxed">
                        {CATEGORY_BLURB[id] ?? 'Panels in this category.'}
                      </div>
                    </button>
                  ))}
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
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedEntry(entry)}
                  className="text-left rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-3.5 flex flex-col hover:border-neutral-300 dark:hover:border-neutral-600 hover:shadow-sm transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-[14.5px] text-neutral-900 dark:text-neutral-50 truncate">
                        {entry.name}
                      </div>
                      <div className="text-[12px] text-neutral-400 font-mono truncate">
                        {entry.id}
                        {entry.author ? ` · ${entry.author}` : ''}
                      </div>
                    </div>
                  </div>
                  {entry.description && (
                    <p className="text-[13px] text-neutral-600 dark:text-neutral-300 mt-1.5 leading-relaxed line-clamp-3">
                      {entry.description}
                    </p>
                  )}
                  {entry.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {entry.tags.slice(0, 6).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 text-[11px] rounded-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-auto pt-3 text-[12px] text-neutral-400">
                    {entry.type === 'team' && entry.agent_count !== undefined
                      ? `${entry.agent_count} agent${entry.agent_count === 1 ? '' : 's'}`
                      : entry.type === 'company' && entry.teams
                        ? `${entry.teams.length} team${entry.teams.length === 1 ? '' : 's'}`
                        : entry.type === 'agent'
                          ? 'single agent'
                          : entry.type === 'panel'
                            ? entry.category ?? 'panel'
                            : ''}
                  </div>
                </button>
              ))}
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
                ((selectedEntry.type !== 'agent' && selectedEntry.type !== 'panel') ||
                  !!targetTeam)
              }
              panelPreview={panelPreview}
              onBack={() => {
                setSelectedEntry(null)
                setPanelPreview(null)
              }}
              onInstall={() => onInstall(selectedEntry)}
              onConfirmPlan={(decision) => {
                if (!panelPreview || !selectedEntry) return
                void applyChosenPanelPlan(selectedEntry, panelPreview, decision)
              }}
              onCancelPreview={() => {
                setPanelPreview(null)
                setInstalling(null)
              }}
            />
          )}
        </div>

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
  panelPreview,
  onBack,
  onInstall,
  onConfirmPlan,
  onCancelPreview,
}: {
  entry: MarketEntry
  justInstalled: boolean
  isInstalling: boolean
  canInstall: boolean
  panelPreview: PanelInstallPreview | null
  onBack: () => void
  onInstall: () => void
  onConfirmPlan: (decision: InstallPlan['decision']) => void
  onCancelPreview: () => void
}) {
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

      <div className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-mono uppercase tracking-wide text-neutral-400">
              {entry.type}
              {entry.type === 'panel' && entry.category ? ` · ${entry.category}` : ''}
            </div>
            <div className="mt-0.5 text-[18px] font-semibold text-neutral-900 dark:text-neutral-50">
              {entry.name}
            </div>
            <div className="text-[12px] text-neutral-400 font-mono mt-0.5">
              {entry.id}
              {entry.author ? ` · ${entry.author}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onInstall}
            disabled={isInstalling || isCompany || !canInstall}
            className={clsx(
              'shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[13px] transition-colors',
              justInstalled
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-800'
                : isCompany
                  ? 'bg-neutral-50 text-neutral-400 border border-neutral-200 dark:bg-neutral-800/60 dark:text-neutral-500 dark:border-neutral-700 cursor-not-allowed'
                  : 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed',
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

        {panelPreview && (
          <InstallConfirmCard
            preview={panelPreview}
            onConfirm={onConfirmPlan}
            onCancel={onCancelPreview}
          />
        )}

        {entry.type === 'panel' && <PanelPreview entry={entry} />}

        {entry.description && (
          <p className="mt-4 text-[14px] leading-relaxed text-neutral-700 dark:text-neutral-200">
            {entry.description}
          </p>
        )}

        {entry.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 text-[11px] rounded-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
          {entry.type === 'team' && entry.agent_count !== undefined && (
            <DetailRow label="Agents" value={String(entry.agent_count)} />
          )}
          {entry.type === 'company' && entry.teams && (
            <DetailRow label="Bundled teams" value={entry.teams.join(', ')} />
          )}
          {entry.type === 'panel' && entry.category && (
            <DetailRow label="Category" value={entry.category} />
          )}
          {entry.author && <DetailRow label="Author" value={entry.author} />}
        </dl>

        {entry.id.startsWith('demo-') && (
          <div className="mt-5 rounded-sm border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-100">
            This is a demo entry from the built-in catalog. It's here to show
            what the market looks like — publish a real frame to the remote repo
            to make it installable.
          </div>
        )}
      </div>
    </div>
  )
}

/** Inline confirmation card that appears above the preview when the
 *  install router suggests a connection. "Connect (recommended)" is the
 *  primary button and takes focus so Enter applies the AI's plan.
 *  "Keep separate" falls back to standalone install. */
function InstallConfirmCard({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: PanelInstallPreview
  onConfirm: (decision: InstallPlan['decision']) => void
  onCancel: () => void
}) {
  const { plan } = preview
  const lowConfidence = plan.confidence < 0.6
  const primaryLabel = lowConfidence ? 'Keep separate' : 'Connect (recommended)'
  const primaryDecision: InstallPlan['decision'] = lowConfidence
    ? 'standalone'
    : plan.decision
  const secondaryDecision: InstallPlan['decision'] = lowConfidence
    ? plan.decision
    : 'standalone'
  const secondaryLabel = lowConfidence ? 'Connect anyway' : 'Keep separate'
  return (
    <div
      className="mt-4 rounded-md border border-amber-300/70 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-950/30 p-4"
      data-testid="install-confirm-card"
      role="region"
      aria-label="Install plan confirmation"
    >
      <div className="text-[12px] uppercase tracking-wide text-amber-700 dark:text-amber-300 font-medium">
        Connect to existing data?
      </div>
      <div className="mt-1 text-[14px] text-neutral-900 dark:text-neutral-50">
        {plan.brief}
      </div>
      {plan.alter_sql.length > 0 && (
        <details className="mt-2 text-[12px] text-neutral-600 dark:text-neutral-300">
          <summary className="cursor-pointer select-none">
            See {plan.alter_sql.length} change{plan.alter_sql.length === 1 ? '' : 's'}
          </summary>
          <pre className="mt-1.5 p-2 rounded-sm bg-white/80 dark:bg-neutral-900/60 font-mono text-[11.5px] overflow-x-auto whitespace-pre-wrap">
            {plan.alter_sql.join('\n')}
          </pre>
        </details>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onConfirm(primaryDecision)}
          autoFocus
          data-testid="install-primary"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[13px] bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 cursor-pointer"
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(secondaryDecision)}
          data-testid="install-secondary"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[13px] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
        >
          {secondaryLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          data-testid="install-cancel"
          className="ml-auto text-[12px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
        >
          Cancel
        </button>
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
function PanelPreview({ entry }: { entry: MarketEntry }) {
  const preview = PANEL_PREVIEWS[entry.id] ?? categoryFallback(entry.category)
  const sizes: PanelSize[] =
    entry.sizes && entry.sizes.length > 0 ? entry.sizes : [DEFAULT_PREVIEW_SIZE]
  const [sizeIndex, setSizeIndex] = useState(0)
  if (!preview) return null
  // Entries can change (user navigates between cards) — clamp index.
  const safeIndex = sizeIndex % sizes.length
  const size = sizes[safeIndex]!
  const cardWidth = size.colSpan * PREVIEW_UNIT_W
  const cardHeight = size.rowSpan * PREVIEW_UNIT_H
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11px] uppercase tracking-wide text-neutral-400">
          Preview
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
              <span className="truncate">{preview.title}</span>
              {preview.subtitle && (
                <span className="shrink-0 ml-2 text-[11px] text-neutral-400">
                  {preview.subtitle}
                </span>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {preview.render()}
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
      <div className="mt-1.5 text-[11.5px] text-neutral-400">
        {sizes.length > 1
          ? `Sample data. Click → to try ${sizes.length} sizes the author defined.`
          : 'Sample data. This panel ships with a single size.'}
      </div>
    </div>
  )
}

type PreviewDef = {
  title: string
  subtitle?: string
  render: () => React.ReactElement
}

const PANEL_PREVIEWS: Record<string, PreviewDef> = {
  'demo-total-count': {
    title: 'Total Count',
    subtitle: 'rows',
    render: () => <KpiPreview value="128" hint="All records" />,
  },
  'demo-sum-metric': {
    title: 'Sum',
    subtitle: 'total value',
    render: () => <KpiPreview value="$42,850" hint="Total value" />,
  },
  'demo-period-change': {
    title: 'Week over Week',
    subtitle: '% change in volume',
    render: () => (
      <KpiPreview value="+12.4%" hint="WoW change (count)" tone="positive" />
    ),
  },
  'demo-trend-line': {
    title: 'Daily Volume — 30 Days',
    render: () => (
      <LineChartPreview
        data={[
          4, 6, 5, 7, 8, 6, 9, 11, 9, 12, 14, 11, 13, 15, 14, 16, 18, 17, 19,
          17, 20, 22, 19, 21, 23, 24, 22, 25, 27, 26,
        ]}
      />
    ),
  },
  'demo-bar-by-category': {
    title: 'Count by Stage',
    render: () => (
      <BarChartPreview
        bars={[
          { label: 'Prospect', value: 42 },
          { label: 'Qualified', value: 28 },
          { label: 'Proposal', value: 17 },
          { label: 'Won', value: 9 },
          { label: 'Lost', value: 6 },
        ]}
      />
    ),
  },
  'demo-stacked-composition': {
    title: 'Value by Stage',
    render: () => (
      <BarChartPreview
        format="currency"
        bars={[
          { label: 'Prospect', value: 15400 },
          { label: 'Qualified', value: 22100 },
          { label: 'Proposal', value: 18600 },
          { label: 'Won', value: 8200 },
          { label: 'Lost', value: 3900 },
        ]}
      />
    ),
  },
}

function categoryFallback(category: string | undefined): PreviewDef | null {
  if (category === 'kpi') {
    return { title: 'KPI', render: () => <KpiPreview value="—" hint="" /> }
  }
  if (category === 'chart') {
    return {
      title: 'Chart',
      render: () => (
        <BarChartPreview
          bars={[
            { label: 'A', value: 6 },
            { label: 'B', value: 9 },
            { label: 'C', value: 4 },
            { label: 'D', value: 11 },
          ]}
        />
      ),
    }
  }
  return null
}

function KpiPreview({
  value,
  hint,
  tone,
}: {
  value: string
  hint: string
  tone?: 'positive' | 'negative'
}) {
  return (
    <div className="h-full flex flex-col justify-between p-4">
      <div className="text-[13px] text-neutral-400">{hint}</div>
      <div
        className={clsx(
          'text-[34px] font-semibold tracking-tight',
          tone === 'positive' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'negative' && 'text-red-600 dark:text-red-400',
          !tone && 'text-neutral-900 dark:text-neutral-50',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function LineChartPreview({ data }: { data: number[] }) {
  const w = 100
  const h = 40
  const max = Math.max(1, ...data)
  const step = data.length > 1 ? w / (data.length - 1) : w
  const points = data.map((v, i) => `${i * step},${h - (v / max) * h}`)
  const polyline = points.join(' ')
  const area = `0,${h} ${polyline} ${w},${h}`
  return (
    <div className="h-full p-3 flex flex-col justify-center">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-28">
        <polygon points={area} className="fill-neutral-200/60 dark:fill-neutral-700/40" />
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          className="text-neutral-700 dark:text-neutral-200"
          points={polyline}
        />
      </svg>
      <div className="mt-2 flex justify-between text-[10.5px] text-neutral-400 font-mono">
        <span>30d ago</span>
        <span>today</span>
      </div>
    </div>
  )
}

function BarChartPreview({
  bars,
  format,
}: {
  bars: { label: string; value: number }[]
  format?: 'currency'
}) {
  const max = Math.max(1, ...bars.map((b) => b.value))
  const fmt = (v: number) =>
    format === 'currency'
      ? `$${v.toLocaleString()}`
      : Intl.NumberFormat().format(v)
  return (
    <div className="h-full p-3 space-y-2 overflow-hidden">
      {bars.map(({ label, value }) => {
        const pct = Math.round((value / max) * 100)
        return (
          <div key={label}>
            <div className="flex items-center justify-between text-[12px] text-neutral-500 mb-0.5">
              <span className="truncate">{label}</span>
              <span className="font-mono">{fmt(value)}</span>
            </div>
            <div className="h-1.5 bg-neutral-100 dark:bg-neutral-800 rounded-sm overflow-hidden">
              <div
                className="h-full bg-neutral-700 dark:bg-neutral-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
