'use client'

import {
  ArrowDown,
  ArrowsDownUp,
  ArrowUp,
  FunnelSimple,
  Plus,
  Sparkle,
  Table as TableIcon,
  X,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchSchema,
  fetchTableRows,
  type ColumnInfo,
  type QueryResult,
  type SchemaResponse,
} from '@/lib/api/teamData'
import { MOCK_ROWS, MOCK_SCHEMA } from '@/lib/mockRecords'
import { useAppStore } from '@/lib/stores/useAppStore'

function isIsoDateString(s: string): boolean {
  // Matches ISO-ish date / datetime strings emitted by JSON.stringify(new Date())
  // or common `YYYY-MM-DD`/`YYYY-MM-DDTHH:mm:ss...`
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)
}

type ColKind = 'number' | 'boolean' | 'date' | 'string'
type SortDir = 'asc' | 'desc'
interface SortRule {
  column: string
  dir: SortDir
}
type FilterOp =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_true'
  | 'is_false'
interface FilterRule {
  id: string
  column: string
  op: FilterOp
  value: string
}

const OP_LABEL: Record<FilterOp, string> = {
  contains: '포함',
  not_contains: '미포함',
  equals: '=',
  not_equals: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_empty: '비어있음',
  is_not_empty: '값 있음',
  is_true: 'true',
  is_false: 'false',
}
const OPS_BY_KIND: Record<ColKind, FilterOp[]> = {
  string: ['contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  date: ['equals', 'gt', 'lt', 'is_empty', 'is_not_empty'],
  boolean: ['is_true', 'is_false'],
}
const NO_VALUE_OPS: ReadonlySet<FilterOp> = new Set([
  'is_empty',
  'is_not_empty',
  'is_true',
  'is_false',
])

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
  const teamId = useAppStore((s) => s.currentTeamId)
  const [schema, setSchema] = useState<SchemaResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [rows, setRows] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isMock, setIsMock] = useState(false)
  const [sortRules, setSortRules] = useState<SortRule[]>([])
  const [filters, setFilters] = useState<FilterRule[]>([])
  const [openPopover, setOpenPopover] = useState<'filter' | 'sort' | null>(null)
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  const sortBtnRef = useRef<HTMLButtonElement>(null)

  const loadSchema = useCallback(async () => {
    const pickDefault = (names: string[]) =>
      setSelected((curr) => (curr && names.includes(curr) ? curr : (names[0] ?? null)))

    if (!teamId) {
      setSchema(MOCK_SCHEMA)
      setIsMock(true)
      pickDefault(MOCK_SCHEMA.tables.map((t) => t.name))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const s = await fetchSchema(teamId)
      if (s.tables.length === 0) {
        setSchema(MOCK_SCHEMA)
        setIsMock(true)
        pickDefault(MOCK_SCHEMA.tables.map((t) => t.name))
      } else {
        setSchema(s)
        setIsMock(false)
        pickDefault(s.tables.map((t) => t.name))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSchema(MOCK_SCHEMA)
      setIsMock(true)
      pickDefault(MOCK_SCHEMA.tables.map((t) => t.name))
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    void loadSchema()
  }, [loadSchema])

  useEffect(() => {
    setSortRules([])
    setFilters([])
    setOpenPopover(null)
    if (!selected) {
      setRows(null)
      return
    }
    if (isMock) {
      setRows(MOCK_ROWS[selected] ?? { columns: [], rows: [] })
      return
    }
    if (!teamId) return
    fetchTableRows(teamId, selected)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [teamId, selected, isMock])

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
                {displayRows.length === rows.rows.length
                  ? `${rows.rows.length} rows`
                  : `${displayRows.length} / ${rows.rows.length} rows`}{' '}
                · {selectedTable.columns.length} cols
              </span>
              <div className="flex-1" />
              <div className="relative">
                <button
                  ref={filterBtnRef}
                  type="button"
                  onClick={() =>
                    setOpenPopover((v) => (v === 'filter' ? null : 'filter'))
                  }
                  className={clsx(
                    'h-8 px-2 rounded-md text-[12px] flex items-center gap-1.5 cursor-pointer',
                    filters.length > 0 || openPopover === 'filter'
                      ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'
                      : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                  )}
                >
                  <FunnelSimple className="w-3.5 h-3.5" />
                  Filter
                  {filters.length > 0 && (
                    <span className="ml-0.5 h-4 min-w-4 px-1 rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[10px] font-mono tabular-nums inline-flex items-center justify-center">
                      {filters.length}
                    </span>
                  )}
                </button>
                {openPopover === 'filter' && (
                  <FilterPopover
                    anchorRef={filterBtnRef}
                    columns={rows.columns}
                    colKinds={colKinds}
                    filters={filters}
                    onChange={setFilters}
                    onClose={() => setOpenPopover(null)}
                  />
                )}
              </div>
              <div className="relative">
                <button
                  ref={sortBtnRef}
                  type="button"
                  onClick={() =>
                    setOpenPopover((v) => (v === 'sort' ? null : 'sort'))
                  }
                  className={clsx(
                    'h-8 px-2 rounded-md text-[12px] flex items-center gap-1.5 cursor-pointer',
                    sortRules.length > 0 || openPopover === 'sort'
                      ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'
                      : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                  )}
                >
                  <ArrowsDownUp className="w-3.5 h-3.5" />
                  Sort
                  {sortRules.length > 0 && (
                    <span className="ml-0.5 h-4 min-w-4 px-1 rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[10px] font-mono tabular-nums inline-flex items-center justify-center">
                      {sortRules.length}
                    </span>
                  )}
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
            </div>

            {(filters.length > 0 || sortRules.length > 0) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {filters.map((f) => (
                  <span
                    key={f.id}
                    className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-900/50 text-[11.5px] text-amber-800 dark:text-amber-200 font-mono"
                  >
                    <FunnelSimple className="w-3 h-3" />
                    <span>{f.column}</span>
                    <span className="text-amber-500">{OP_LABEL[f.op]}</span>
                    {!NO_VALUE_OPS.has(f.op) && (
                      <span className="text-amber-900 dark:text-amber-100">
                        "{f.value}"
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setFilters((prev) => prev.filter((x) => x.id !== f.id))
                      }
                      className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-amber-200/70 dark:hover:bg-amber-900/60 cursor-pointer"
                      aria-label="필터 제거"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
                {sortRules.map((r) => (
                  <span
                    key={r.column}
                    className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-blue-50 dark:bg-blue-950/40 border border-blue-200/70 dark:border-blue-900/50 text-[11.5px] text-blue-800 dark:text-blue-200 font-mono"
                  >
                    {r.dir === 'asc' ? (
                      <ArrowUp className="w-3 h-3" />
                    ) : (
                      <ArrowDown className="w-3 h-3" />
                    )}
                    <span>{r.column}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setSortRules((prev) =>
                          prev.filter((x) => x.column !== r.column),
                        )
                      }
                      className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-blue-200/70 dark:hover:bg-blue-900/60 cursor-pointer"
                      aria-label="정렬 제거"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setFilters([])
                    setSortRules([])
                  }}
                  className="text-[11.5px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 underline-offset-2 hover:underline cursor-pointer ml-1"
                >
                  모두 지우기
                </button>
              </div>
            )}
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

        {isMock && (
          <div className="shrink-0 mx-3 mb-3 rounded-lg border border-dashed border-violet-300 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-950/20 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
              <Sparkle className="w-3 h-3" weight="fill" />
              목업 데이터
            </div>
            <p className="text-[11px] text-violet-600/80 dark:text-violet-400/80 leading-snug mt-0.5">
              실제 테이블이 없어 미리보기를 보여줍니다.
            </p>
          </div>
        )}
      </aside>

        {/* Right: table body */}
        <div className="flex-1 flex flex-col min-w-0">
          {selectedTable && rows ? (
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
                        <td
                          colSpan={rows.columns.length}
                          className="text-center px-3 py-16"
                        >
                          <div className="text-[13px] text-neutral-400">
                            {rows.rows.length === 0
                              ? '비어있는 테이블입니다'
                              : '필터 조건에 맞는 행이 없습니다'}
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
                <div className="p-6 text-[13px] text-neutral-400">데이터 로딩 중…</div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[13px] text-neutral-400">
              {loading ? '로딩 중…' : '테이블을 선택하세요'}
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

function FilterPopover({
  anchorRef,
  columns,
  colKinds,
  filters,
  onChange,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  columns: string[]
  colKinds: Record<string, ColKind>
  filters: FilterRule[]
  onChange: (next: FilterRule[]) => void
  onClose: () => void
}) {
  const panelRef = usePopoverClose(anchorRef, onClose)
  const addFilter = () => {
    const col = columns[0]
    if (!col) return
    const kind = colKinds[col] ?? 'string'
    const op = (OPS_BY_KIND[kind][0] ?? 'contains') as FilterOp
    const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    onChange([...filters, { id, column: col, op, value: '' }])
  }
  const update = (id: string, patch: Partial<FilterRule>) => {
    onChange(
      filters.map((f) => {
        if (f.id !== id) return f
        const next = { ...f, ...patch }
        // If column changed, reset op to first valid op for new kind
        if (patch.column && patch.column !== f.column) {
          const kind = colKinds[patch.column] ?? 'string'
          next.op = (OPS_BY_KIND[kind][0] ?? 'contains') as FilterOp
          next.value = ''
        }
        return next
      }),
    )
  }
  const remove = (id: string) => onChange(filters.filter((f) => f.id !== id))

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-9 z-30 w-[420px] rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-[0_8px_24px_rgba(0,0,0,0.08)] px-3 py-3"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
          필터
        </span>
        {filters.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[11.5px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
          >
            초기화
          </button>
        )}
      </div>
      {filters.length === 0 ? (
        <div className="text-[12px] text-neutral-400 py-3 text-center">
          설정된 필터가 없습니다
        </div>
      ) : (
        <div className="space-y-1.5">
          {filters.map((f) => {
            const kind = colKinds[f.column] ?? 'string'
            const ops = OPS_BY_KIND[kind]
            const needsValue = !NO_VALUE_OPS.has(f.op)
            return (
              <div key={f.id} className="flex items-center gap-1.5">
                <select
                  value={f.column}
                  onChange={(e) => update(f.id, { column: e.target.value })}
                  className="h-7 px-1.5 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-[12px] font-mono min-w-0 flex-1 cursor-pointer focus:outline-none focus:border-neutral-400"
                >
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  value={f.op}
                  onChange={(e) => update(f.id, { op: e.target.value as FilterOp })}
                  className="h-7 px-1.5 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-[12px] cursor-pointer focus:outline-none focus:border-neutral-400"
                >
                  {ops.map((op) => (
                    <option key={op} value={op}>
                      {OP_LABEL[op]}
                    </option>
                  ))}
                </select>
                {needsValue ? (
                  <input
                    value={f.value}
                    onChange={(e) => update(f.id, { value: e.target.value })}
                    placeholder={kind === 'number' ? '0' : kind === 'date' ? 'YYYY-MM-DD' : ''}
                    className="h-7 px-2 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-[12px] font-mono w-[130px] focus:outline-none focus:border-neutral-400"
                  />
                ) : (
                  <span className="w-[130px]" />
                )}
                <button
                  type="button"
                  onClick={() => remove(f.id)}
                  className="w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer shrink-0"
                  aria-label="필터 제거"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <button
        type="button"
        onClick={addFilter}
        className="mt-2 w-full h-7 rounded-md border border-dashed border-neutral-200 dark:border-neutral-800 text-[12px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 hover:border-neutral-300 dark:hover:border-neutral-700 flex items-center justify-center gap-1.5 cursor-pointer"
      >
        <Plus className="w-3.5 h-3.5" />
        필터 추가
      </button>
    </div>
  )
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
  const panelRef = usePopoverClose(anchorRef, onClose)
  const used = new Set(rules.map((r) => r.column))
  const available = columns.filter((c) => !used.has(c))

  const addRule = () => {
    const col = available[0]
    if (!col) return
    onChange([...rules, { column: col, dir: 'asc' }])
  }
  const update = (idx: number, patch: Partial<SortRule>) =>
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= rules.length) return
    const next = rules.slice()
    ;[next[idx], next[j]] = [next[j]!, next[idx]!]
    onChange(next)
  }
  const remove = (idx: number) => onChange(rules.filter((_, i) => i !== idx))

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-9 z-30 w-[360px] rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-[0_8px_24px_rgba(0,0,0,0.08)] px-3 py-3"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
          정렬
        </span>
        {rules.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[11.5px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 cursor-pointer"
          >
            초기화
          </button>
        )}
      </div>
      {rules.length === 0 ? (
        <div className="text-[12px] text-neutral-400 py-3 text-center">
          설정된 정렬이 없습니다
        </div>
      ) : (
        <div className="space-y-1.5">
          {rules.map((r, idx) => (
            <div key={r.column} className="flex items-center gap-1.5">
              <span className="text-[10.5px] font-mono tabular-nums text-neutral-400 w-4 text-right shrink-0">
                {idx + 1}
              </span>
              <select
                value={r.column}
                onChange={(e) => update(idx, { column: e.target.value })}
                className="h-7 px-1.5 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-[12px] font-mono flex-1 min-w-0 cursor-pointer focus:outline-none focus:border-neutral-400"
              >
                {/* Current column always selectable; other used columns excluded */}
                {columns
                  .filter((c) => c === r.column || !used.has(c))
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  update(idx, { dir: r.dir === 'asc' ? 'desc' : 'asc' })
                }
                className="h-7 px-2 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-[11.5px] flex items-center gap-1 hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
              >
                {r.dir === 'asc' ? (
                  <>
                    <ArrowUp className="w-3 h-3" />
                    asc
                  </>
                ) : (
                  <>
                    <ArrowDown className="w-3 h-3" />
                    desc
                  </>
                )}
              </button>
              <div className="flex flex-col shrink-0">
                <button
                  type="button"
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                  className="w-5 h-3.5 rounded-sm flex items-center justify-center text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-default cursor-pointer"
                  aria-label="우선순위 위로"
                >
                  <ArrowUp className="w-2.5 h-2.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(idx, 1)}
                  disabled={idx === rules.length - 1}
                  className="w-5 h-3.5 rounded-sm flex items-center justify-center text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-default cursor-pointer"
                  aria-label="우선순위 아래로"
                >
                  <ArrowDown className="w-2.5 h-2.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => remove(idx)}
                className="w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer shrink-0"
                aria-label="정렬 제거"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={addRule}
        disabled={available.length === 0}
        className="mt-2 w-full h-7 rounded-md border border-dashed border-neutral-200 dark:border-neutral-800 text-[12px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 hover:border-neutral-300 dark:hover:border-neutral-700 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-default"
      >
        <Plus className="w-3.5 h-3.5" />
        정렬 추가
      </button>
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
      <span className="text-neutral-800 dark:text-neutral-200 tabular-nums">
        {String(value)}
      </span>
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

