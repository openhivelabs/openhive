import {
  type ColumnInfo,
  type PagedQueryResult,
  type SchemaResponse,
  fetchSchema,
  fetchTableRows,
} from '@/lib/api/teamData'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import {
  ArrowDown,
  ArrowUp,
  ArrowsDownUp,
  CaretLeft,
  CaretRight,
  Table as TableIcon,
  X,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type ColKind, type FilterOp, type FilterRule, RecordsSearchBar } from './RecordsSearchBar'

function isIsoDateString(s: string): boolean {
  // Matches ISO-ish date / datetime strings emitted by JSON.stringify(new Date())
  // or common `YYYY-MM-DD`/`YYYY-MM-DDTHH:mm:ss...`
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)
}

type SortDir = 'asc' | 'desc'
interface SortRule {
  column: string
  dir: SortDir
}

function colKindOf(col: ColumnInfo | undefined, sample: unknown): ColKind {
  const t = (col?.type ?? '').toUpperCase()
  if (t.includes('BOOL')) return 'boolean'
  if (
    t.includes('INT') ||
    t.includes('REAL') ||
    t.includes('NUM') ||
    t.includes('FLOAT') ||
    t.includes('DOUBLE') ||
    t.includes('DECIMAL')
  )
    return 'number'
  if (t.includes('DATE') || t.includes('TIME')) return 'date'
  if (typeof sample === 'boolean') return 'boolean'
  if (typeof sample === 'number') return 'number'
  if (typeof sample === 'string' && isIsoDateString(sample)) return 'date'
  return 'string'
}

function cmpValues(a: unknown, b: unknown, kind: ColKind): number {
  const aNull = a === null || a === undefined || a === ''
  const bNull = b === null || b === undefined || b === ''
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  if (kind === 'number') return Number(a) - Number(b)
  if (kind === 'boolean') return Number(Boolean(a)) - Number(Boolean(b))
  if (kind === 'date') {
    return new Date(String(a)).getTime() - new Date(String(b)).getTime()
  }
  return String(a).localeCompare(String(b))
}

function matchesFilter(rule: FilterRule, row: Record<string, unknown>, kind: ColKind): boolean {
  const v = row[rule.column]
  if (rule.op === 'is_empty') return v === null || v === undefined || v === ''
  if (rule.op === 'is_not_empty') return !(v === null || v === undefined || v === '')
  if (rule.op === 'is_true') return v === true || v === 1 || v === '1' || v === 'true'
  if (rule.op === 'is_false') return v === false || v === 0 || v === '0' || v === 'false'
  if (v === null || v === undefined) return false
  const val = rule.value
  if (kind === 'number') {
    const a = Number(v)
    const b = Number(val)
    if (Number.isNaN(b)) return false
    if (rule.op === 'equals') return a === b
    if (rule.op === 'not_equals') return a !== b
    if (rule.op === 'gt') return a > b
    if (rule.op === 'gte') return a >= b
    if (rule.op === 'lt') return a < b
    if (rule.op === 'lte') return a <= b
    return true
  }
  if (kind === 'date') {
    const a = new Date(String(v)).getTime()
    const b = new Date(val).getTime()
    if (Number.isNaN(b)) return true
    if (rule.op === 'equals') {
      const da = new Date(a)
      const db = new Date(b)
      return (
        da.getFullYear() === db.getFullYear() &&
        da.getMonth() === db.getMonth() &&
        da.getDate() === db.getDate()
      )
    }
    if (rule.op === 'gt') return a > b
    if (rule.op === 'lt') return a < b
    return true
  }
  const s = String(v).toLowerCase()
  const q = val.toLowerCase()
  if (rule.op === 'contains') return s.includes(q)
  if (rule.op === 'not_contains') return !s.includes(q)
  if (rule.op === 'equals') return s === q
  if (rule.op === 'not_equals') return s !== q
  return true
}

export function DatabaseView() {
  const t = useT()
  const teamId = useAppStore((s) => s.currentTeamId)
  const [schema, setSchema] = useState<SchemaResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [rows, setRows] = useState<PagedQueryResult | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortRules, setSortRules] = useState<SortRule[]>([])
  const [filters, setFilters] = useState<FilterRule[]>([])
  const [openPopover, setOpenPopover] = useState<'sort' | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const sortBtnRef = useRef<HTMLButtonElement>(null)
  const PAGE_SIZE = 100

  const loadSchema = useCallback(async () => {
    const pickDefault = (names: string[]) =>
      setSelected((curr) => (curr && names.includes(curr) ? curr : (names[0] ?? null)))

    if (!teamId) {
      setSchema({ tables: [], recent_migrations: [] })
      setSelected(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const s = await fetchSchema(teamId)
      setSchema(s)
      pickDefault(s.tables.map((t) => t.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSchema({ tables: [], recent_migrations: [] })
      setSelected(null)
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    void loadSchema()
  }, [loadSchema])

  useEffect(() => {
    // `selected` is the trigger — resets must run when it changes.
    void selected
    setSortRules([])
    setFilters([])
    setOpenPopover(null)
    setAiError(null)
    setPage(1)
  }, [selected])

  useEffect(() => {
    if (!selected || !teamId) {
      setRows(null)
      return
    }
    fetchTableRows(teamId, selected, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [teamId, selected, page])

  const tables = schema?.tables ?? []
  const selectedTable = tables.find((t) => t.name === selected)

  const colKinds = useMemo<Record<string, ColKind>>(() => {
    if (!rows) return {}
    const out: Record<string, ColKind> = {}
    for (const c of rows.columns) {
      const schemaCol = selectedTable?.columns.find((x) => x.name === c)
      const sample = rows.rows.find((r) => r[c] !== null && r[c] !== undefined)?.[c]
      out[c] = colKindOf(schemaCol, sample)
    }
    return out
  }, [rows, selectedTable])

  const askAi = useCallback(
    async (query: string) => {
      if (!rows || rows.columns.length === 0) return
      setAiBusy(true)
      setAiError(null)
      try {
        const cols = rows.columns.map((c) => ({
          name: c,
          kind: (colKinds[c] ?? 'string') as ColKind,
        }))
        const resp = await fetch('/api/ai/records-filter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columns: cols, query }),
        })
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { detail?: string }
          throw new Error(body.detail || `AI filter failed (${resp.status})`)
        }
        const data = (await resp.json()) as {
          filters?: { column: string; op: FilterOp; value: string }[]
        }
        const next = (data.filters ?? []).map((f) => ({
          id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ...f,
        }))
        if (next.length === 0) {
          setAiError(t('records.search.aiNoMatch'))
          return
        }
        setFilters((prev) => [...prev, ...next])
      } catch (e) {
        setAiError(e instanceof Error ? e.message : String(e))
      } finally {
        setAiBusy(false)
      }
    },
    [rows, colKinds, t],
  )

  const displayRows = useMemo(() => {
    if (!rows) return [] as Record<string, unknown>[]
    let out = rows.rows
    if (filters.length > 0) {
      out = out.filter((row) =>
        filters.every((f) => matchesFilter(f, row, colKinds[f.column] ?? 'string')),
      )
    }
    if (sortRules.length > 0) {
      const indexed = out.map((r, i) => ({ r, i }))
      indexed.sort((a, b) => {
        for (const rule of sortRules) {
          const kind = colKinds[rule.column] ?? 'string'
          const c = cmpValues(a.r[rule.column], b.r[rule.column], kind)
          if (c !== 0) return rule.dir === 'asc' ? c : -c
        }
        return a.i - b.i
      })
      out = indexed.map((x) => x.r)
    }
    return out
  }, [rows, filters, sortRules, colKinds])

  return (
    <div className="h-full flex flex-col bg-white dark:bg-neutral-950">
      {/* Top header — spans the full width above sidebar + table body */}
      <div className="shrink-0 border-b border-neutral-200 dark:border-neutral-800 px-6 py-2.5 min-h-[53px] flex flex-col justify-center">
        {selectedTable && rows ? (
          <>
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-mono font-semibold text-neutral-900 dark:text-neutral-100">
                {selectedTable.name}
              </h2>
              <span className="text-[11.5px] text-neutral-400 font-mono tabular-nums">
                {t('records.db.totalRows', { total: String(rows.total) })}{' '}
                · {t('records.db.colCount', { n: String(selectedTable.columns.length) })}
              </span>
              <RecordsSearchBar
                columns={rows.columns}
                colKinds={colKinds}
                filters={filters}
                onChange={setFilters}
                onAskAi={askAi}
                aiBusy={aiBusy}
                aiError={aiError}
              />
              <div className="relative">
                <button
                  ref={sortBtnRef}
                  type="button"
                  onClick={() => setOpenPopover((v) => (v === 'sort' ? null : 'sort'))}
                  className={clsx(
                    'h-8 px-2 rounded-md text-[12px] flex items-center gap-1.5 cursor-pointer',
                    sortRules.length > 0 || openPopover === 'sort'
                      ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'
                      : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                  )}
                >
                  <ArrowsDownUp className="w-3.5 h-3.5" />
                  {t('records.sort.buttonLabel')}
                </button>
                {openPopover === 'sort' && (
                  <SortPopover
                    anchorRef={sortBtnRef}
                    columns={rows.columns}
                    rules={sortRules}
                    onChange={setSortRules}
                    onClose={() => setOpenPopover(null)}
                  />
                )}
              </div>
              {sortRules.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {sortRules.map((r) => (
                    <span
                      key={r.column}
                      className="inline-flex items-center gap-1.5 h-8 pl-2 pr-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-[12px] text-neutral-700 dark:text-neutral-200 font-mono"
                    >
                      {r.dir === 'asc' ? (
                        <ArrowUp className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400" />
                      ) : (
                        <ArrowDown className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400" />
                      )}
                      <span>{r.column}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setSortRules((prev) => prev.filter((x) => x.column !== r.column))
                        }
                        className="w-4 h-4 rounded-sm flex items-center justify-center text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 cursor-pointer"
                        aria-label={t('records.search.removeFilter')}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>

      {error && (
        <div className="mx-6 mt-3 rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 text-[12px] px-3 py-2 font-mono">
          {error}
        </div>
      )}

      {/* Main: sidebar + table body */}
      <div className="flex-1 flex min-h-0">
        <aside className="w-[240px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950 flex flex-col">
          <div className="flex-1 overflow-y-auto px-2 py-3">
            <div className="space-y-0.5">
              {tables.map((tbl) => {
                const active = selected === tbl.name
                return (
                  <button
                    key={tbl.name}
                    type="button"
                    onClick={() => setSelected(tbl.name)}
                    className={clsx(
                      'w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 group transition-colors cursor-pointer',
                      active
                        ? 'bg-white dark:bg-neutral-800 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-neutral-200 dark:ring-neutral-700'
                        : 'hover:bg-white/70 dark:hover:bg-neutral-800/60',
                    )}
                  >
                    <TableIcon
                      className={clsx(
                        'w-3.5 h-3.5 shrink-0',
                        active ? 'text-neutral-700 dark:text-neutral-300' : 'text-neutral-400',
                      )}
                    />
                    <span
                      className={clsx(
                        'text-[13px] font-mono truncate flex-1',
                        active
                          ? 'text-neutral-900 dark:text-neutral-100 font-medium'
                          : 'text-neutral-700 dark:text-neutral-300',
                      )}
                    >
                      {tbl.name}
                    </span>
                    <span className="text-[10.5px] font-mono tabular-nums text-neutral-400 shrink-0">
                      {tbl.row_count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

        </aside>

        {/* Right: table body */}
        <div className="flex-1 flex flex-col min-w-0">
          {selectedTable && rows ? (
            <>
            <div className="flex-1 overflow-auto">
              {rows.columns.length > 0 ? (
                <table className="w-full text-[13px] border-separate border-spacing-0">
                  <thead className="sticky top-0 z-10 bg-neutral-50/95 dark:bg-neutral-950/95 backdrop-blur">
                    <tr>
                      {rows.columns.map((c, i) => (
                        <th
                          key={c}
                          className={clsx(
                            'text-left font-medium text-[11px] uppercase tracking-[0.06em] text-neutral-500 dark:text-neutral-400 px-3 py-2.5 border-b border-neutral-200 dark:border-neutral-800 whitespace-nowrap',
                            i === 0 && 'pl-6',
                            i === rows.columns.length - 1 && 'pr-6',
                          )}
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.length === 0 ? (
                      <tr>
                        <td colSpan={rows.columns.length} className="text-center px-3 py-16">
                          <div className="text-[13px] text-neutral-400">
                            {rows.rows.length === 0
                              ? t('records.db.emptyTable')
                              : t('records.db.noFilterMatch')}
                          </div>
                        </td>
                      </tr>
                    ) : (
                      displayRows.map((row, i) => (
                        <tr
                          key={i}
                          className="hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors"
                        >
                          {rows.columns.map((c, j) => (
                            <td
                              key={c}
                              className={clsx(
                                'px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800/60 align-top font-mono text-[12.5px]',
                                j === 0 && 'pl-6',
                                j === rows.columns.length - 1 && 'pr-6',
                              )}
                            >
                              <Cell value={row[c]} />
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
                <div className="p-6 text-[13px] text-neutral-400">
                  {t('records.db.loadingData')}
                </div>
              )}
            </div>
            {(() => {
              const totalPages = Math.max(1, Math.ceil(rows.total / PAGE_SIZE))
              if (totalPages <= 1) return null
              return (
                <div className="shrink-0 border-t border-neutral-200 dark:border-neutral-800 px-6 h-10 flex items-center justify-between gap-3">
                  <span className="text-[11.5px] text-neutral-400">
                    {(filters.length > 0 || sortRules.length > 0) &&
                      t('records.db.filterPageHint')}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      aria-label={t('records.db.prevPage')}
                      title={t('records.db.prevPage')}
                      className="h-7 w-7 rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 flex items-center justify-center hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent cursor-pointer"
                    >
                      <CaretLeft className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-[11.5px] text-neutral-500 font-mono tabular-nums min-w-[96px] text-center">
                      {t('records.db.pageOf', {
                        page: String(page),
                        pages: String(totalPages),
                      })}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      aria-label={t('records.db.nextPage')}
                      title={t('records.db.nextPage')}
                      className="h-7 w-7 rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 flex items-center justify-center hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent cursor-pointer"
                    >
                      <CaretRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })()}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[13px] text-neutral-400">
              {loading ? t('records.db.loading') : t('records.db.selectTable')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function usePopoverClose(
  anchorRef: React.RefObject<HTMLButtonElement | null>,
  onClose: () => void,
) {
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])
  return panelRef
}

function SortPopover({
  anchorRef,
  columns,
  rules,
  onChange,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  columns: string[]
  rules: SortRule[]
  onChange: (next: SortRule[]) => void
  onClose: () => void
}) {
  const t = useT()
  const panelRef = usePopoverClose(anchorRef, onClose)
  const ruleByCol = new Map(rules.map((r) => [r.column, r] as const))

  const toggle = (column: string, dir: SortDir) => {
    const existing = ruleByCol.get(column)
    if (!existing) {
      onChange([...rules, { column, dir }])
      return
    }
    if (existing.dir === dir) {
      onChange(rules.filter((r) => r.column !== column))
      return
    }
    onChange(rules.map((r) => (r.column === column ? { ...r, dir } : r)))
  }

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-9 z-30 w-[280px] max-h-[360px] overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-[0_8px_24px_rgba(0,0,0,0.08)] py-1"
    >
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
          {t('records.sort.title')}
        </span>
        {rules.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[11.5px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
          >
            {t('records.sort.reset')}
          </button>
        )}
      </div>
      <div>
        {columns.map((c) => {
          const rule = ruleByCol.get(c)
          return (
            <div
              key={c}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
            >
              <span className="text-[13px] font-mono text-neutral-800 dark:text-neutral-200 truncate flex-1">
                {c}
              </span>
              <button
                type="button"
                onClick={() => toggle(c, 'asc')}
                aria-label={t('records.sort.asc')}
                title={t('records.sort.asc')}
                className={clsx(
                  'w-7 h-6 rounded flex items-center justify-center cursor-pointer',
                  rule?.dir === 'asc'
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                )}
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => toggle(c, 'desc')}
                aria-label={t('records.sort.desc')}
                title={t('records.sort.desc')}
                className={clsx(
                  'w-7 h-6 rounded flex items-center justify-center cursor-pointer',
                  rule?.dir === 'desc'
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                )}
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-neutral-300 dark:text-neutral-700">NULL</span>
  }
  if (value === '') {
    return <span className="text-neutral-300 dark:text-neutral-700">—</span>
  }
  if (typeof value === 'boolean') {
    return (
      <span className="text-neutral-700 dark:text-neutral-300 tabular-nums">
        {value ? 'true' : 'false'}
      </span>
    )
  }
  if (typeof value === 'number') {
    return (
      <span className="text-neutral-800 dark:text-neutral-200 tabular-nums">{String(value)}</span>
    )
  }
  if (typeof value === 'object') {
    const s = JSON.stringify(value)
    return (
      <span
        className="text-neutral-600 dark:text-neutral-400 truncate max-w-[420px] inline-block align-top"
        title={s}
      >
        {s}
      </span>
    )
  }
  const s = String(value)
  // ISO-like datetime gets a slightly muted tone, but no reformatting —
  // we show what's actually stored.
  if (isIsoDateString(s)) {
    return (
      <span
        className="text-neutral-600 dark:text-neutral-400 tabular-nums truncate max-w-[420px] inline-block align-top"
        title={s}
      >
        {s}
      </span>
    )
  }
  return (
    <span
      className="text-neutral-800 dark:text-neutral-200 truncate max-w-[420px] inline-block align-top"
      title={s}
    >
      {s}
    </span>
  )
}
