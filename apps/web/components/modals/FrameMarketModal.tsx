import {
  Buildings,
  CircleNotch,
  CloudSlash,
  DownloadSimple,
  MagnifyingGlass,
  Package,
  Robot,
  Users as UsersIcon,
  Warning,
  X,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { teamFromInstallResult } from '@/lib/api/frames'
import {
  type MarketEntry,
  type MarketIndex,
  type MarketType,
  fetchMarketIndex,
  installMarketEntry,
} from '@/lib/api/market'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useAppStore } from '@/lib/stores/useAppStore'

interface Props {
  open: boolean
  onClose: () => void
  /** Preselected target company for team/agent installs. User can still
   *  switch to any other company via the dropdown inside the modal. */
  defaultCompanyId?: string | null
  /** Preselected target team for agent installs. Only honoured if the team
   *  actually belongs to the preselected company. */
  defaultTeamId?: string | null
  /** Restrict visible tabs. Defaults to all three (company/team/agent).
   *  When passed, the initial tab is the first entry in this list.
   *  If only one tab remains visible the tab bar is hidden. */
  allowedTabs?: MarketType[]
  /** Hide the "Install into" target picker. Install target is fixed to
   *  defaultCompanyId / defaultTeamId. Use when the invoking flow already
   *  implies a target (e.g. "New team" inside a specific company). */
  lockTarget?: boolean
}

const TAB_DEFS: { type: MarketType; label: string; icon: typeof UsersIcon }[] = [
  { type: 'company', label: 'Companies', icon: Buildings },
  { type: 'team', label: 'Teams', icon: UsersIcon },
  { type: 'agent', label: 'Agents', icon: Robot },
]

export function FrameMarketModal({
  open,
  onClose,
  defaultCompanyId,
  defaultTeamId,
  allowedTabs,
  lockTarget,
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

  const entries = useMemo<MarketEntry[]>(() => {
    if (!index) return []
    const bucket =
      tab === 'company' ? index.companies : tab === 'team' ? index.teams : index.agents
    if (!query.trim()) return bucket
    const q = query.trim().toLowerCase()
    return bucket.filter((e) => {
      const hay =
        `${e.name} ${e.description} ${(e.tags ?? []).join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }, [index, tab, query])

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
    if (entry.type === 'agent' && !targetTeam) {
      setInstallError('해당 회사에 팀이 없어요. 먼저 팀을 하나 만들어주세요.')
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
      // Reset the transient check mark so a repeat click reads "Install" again.
      setTimeout(() => {
        setLastInstalled((cur) => (cur === entry.id ? null : cur))
      }, 2000)
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e))
    } finally {
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

        {/* Tabs + search + target picker */}
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
                      : index.agents.length
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

          {/* Install target pickers — only for team/agent */}
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
              {tab === 'agent' && (
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

          {!loading && entries.length === 0 && !loadError && (
            <div className="text-center py-16 text-neutral-400 text-[14px]">
              {query.trim()
                ? `No ${tab} frames match "${query}".`
                : `No ${tab} frames in the catalog yet.`}
            </div>
          )}

          {entries.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {entries.map((entry) => {
                const justInstalled = lastInstalled === entry.id
                const isInstalling = installing === entry.id
                const isCompany = entry.type === 'company'
                return (
                  <div
                    key={entry.id}
                    className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-3.5 flex flex-col"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-[14.5px] text-neutral-900 dark:text-neutral-50 truncate">
                          {entry.name}
                        </div>
                        <div className="text-[12px] text-neutral-400 font-mono truncate">
                          {entry.id} · v{entry.version}
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
                    <div className="mt-auto pt-3 flex items-center justify-between">
                      <div className="text-[12px] text-neutral-400">
                        {entry.type === 'team' && entry.agent_count !== undefined
                          ? `${entry.agent_count} agent${entry.agent_count === 1 ? '' : 's'}`
                          : entry.type === 'company' && entry.teams
                            ? `${entry.teams.length} team${entry.teams.length === 1 ? '' : 's'}`
                            : entry.type === 'agent'
                              ? 'single agent'
                              : ''}
                      </div>
                      <button
                        type="button"
                        onClick={() => onInstall(entry)}
                        disabled={
                          isInstalling ||
                          isCompany ||
                          (!isCompany && !targetCompany) ||
                          (entry.type === 'agent' && !targetTeam)
                        }
                        className={clsx(
                          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[13px] transition-colors',
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
                  </div>
                )
              })}
            </div>
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
