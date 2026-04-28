import { useT } from '@/lib/i18n'
import { MagnifyingGlass, Sparkle, X } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type ColKind = 'number' | 'boolean' | 'date' | 'string'

export type FilterOp =
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

export interface FilterRule {
  id: string
  column: string
  op: FilterOp
  value: string
}

const OPS_BY_KIND: Record<ColKind, FilterOp[]> = {
  string: ['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'is_not_empty'],
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

const OP_SYMBOL: Record<FilterOp, string> = {
  equals: '=',
  not_equals: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  contains: '~~',
  not_contains: '!~~',
  is_empty: 'is null',
  is_not_empty: 'is not null',
  is_true: 'is true',
  is_false: 'is false',
}

type OpGroup = {
  title: string
  ops: FilterOp[]
}

function opGroupsForKind(kind: ColKind, t: (k: string) => string): OpGroup[] {
  const groups: OpGroup[] = []
  const comparison: FilterOp[] = []
  const pattern: FilterOp[] = []
  const emptiness: FilterOp[] = []
  const boolean: FilterOp[] = []
  for (const op of OPS_BY_KIND[kind]) {
    if (
      op === 'equals' ||
      op === 'not_equals' ||
      op === 'gt' ||
      op === 'gte' ||
      op === 'lt' ||
      op === 'lte'
    ) {
      comparison.push(op)
    } else if (op === 'contains' || op === 'not_contains') {
      pattern.push(op)
    } else if (op === 'is_empty' || op === 'is_not_empty') {
      emptiness.push(op)
    } else {
      boolean.push(op)
    }
  }
  if (comparison.length > 0)
    groups.push({ title: t('records.search.group.comparison'), ops: comparison })
  if (pattern.length > 0) groups.push({ title: t('records.search.group.pattern'), ops: pattern })
  if (emptiness.length > 0)
    groups.push({ title: t('records.search.group.emptiness'), ops: emptiness })
  if (boolean.length > 0) groups.push({ title: t('records.search.group.boolean'), ops: boolean })
  return groups
}

interface RecordsSearchBarProps {
  columns: string[]
  colKinds: Record<string, ColKind>
  filters: FilterRule[]
  onChange: (next: FilterRule[]) => void
  onAskAi: (query: string) => Promise<void>
  aiBusy?: boolean
  aiError?: string | null
}

type DraftPhase =
  | { phase: 'idle' }
  | { phase: 'column'; column: string; kind: ColKind }
  | { phase: 'value'; column: string; kind: ColKind; op: FilterOp }

function newId() {
  return `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

export function RecordsSearchBar({
  columns,
  colKinds,
  filters,
  onChange,
  onAskAi,
  aiBusy,
  aiError,
}: RecordsSearchBarProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [draft, setDraft] = useState<DraftPhase>({ phase: 'idle' })
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const closeAll = useCallback(() => {
    setOpen(false)
    setInput('')
    setDraft({ phase: 'idle' })
  }, [])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current) return
      if (wrapRef.current.contains(e.target as Node)) return
      closeAll()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeAll()
        inputRef.current?.blur()
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closeAll])

  const matchingColumns = useMemo(() => {
    const q = input.trim().toLowerCase()
    if (!q) return columns
    return columns.filter((c) => c.toLowerCase().includes(q))
  }, [columns, input])

  const pickColumn = (col: string) => {
    const kind = colKinds[col] ?? 'string'
    setDraft({ phase: 'column', column: col, kind })
    setInput('')
    setOpen(true)
    inputRef.current?.focus()
  }

  const pickOp = (op: FilterOp) => {
    if (draft.phase !== 'column') return
    if (NO_VALUE_OPS.has(op)) {
      onChange([...filters, { id: newId(), column: draft.column, op, value: '' }])
      setDraft({ phase: 'idle' })
      setInput('')
    } else {
      setDraft({ phase: 'value', column: draft.column, kind: draft.kind, op })
      setInput('')
    }
    setOpen(true)
    inputRef.current?.focus()
  }

  const commitValue = (raw: string) => {
    if (draft.phase !== 'value') return
    const value = raw.trim()
    if (!value) return
    onChange([...filters, { id: newId(), column: draft.column, op: draft.op, value }])
    setDraft({ phase: 'idle' })
    setInput('')
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ignore keys fired while an IME (Korean/Japanese/Chinese) is still
    // composing — keyCode 229 / isComposing. Otherwise Enter would commit
    // the input state mid-composition and the trailing character leaks
    // into the next phase.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Backspace' && input === '') {
      if (draft.phase === 'value') {
        setDraft({ phase: 'column', column: draft.column, kind: draft.kind })
        e.preventDefault()
        return
      }
      if (draft.phase === 'column') {
        setDraft({ phase: 'idle' })
        e.preventDefault()
        return
      }
      if (filters.length > 0) {
        onChange(filters.slice(0, -1))
        e.preventDefault()
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (draft.phase === 'value') {
        commitValue(input)
        return
      }
      if (draft.phase === 'idle') {
        const q = input.trim()
        if (!q) return
        const exact = columns.find((c) => c.toLowerCase() === q.toLowerCase())
        if (exact) {
          pickColumn(exact)
          return
        }
        if (matchingColumns.length === 1 && matchingColumns[0]) {
          pickColumn(matchingColumns[0])
          return
        }
        // Natural-language → AI
        void onAskAi(q).then(() => {
          setInput('')
        })
      }
    }
  }

  const removeFilter = (id: string) => onChange(filters.filter((f) => f.id !== id))

  const placeholder = useMemo(() => {
    if (filters.length > 0) return t('records.search.addMore')
    if (columns.length === 0) return t('records.search.placeholderEmpty')
    const preview = columns.slice(0, 3).join(', ')
    return t('records.search.placeholder', { columns: preview })
  }, [columns, filters.length, t])

  const showDropdown = open
  const canAskAi = draft.phase === 'idle' && input.trim().length > 0

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-0 max-w-[520px]">
      <div
        className={clsx(
          'flex items-center gap-1 h-8 pl-2.5 pr-2 rounded-md border bg-white dark:bg-neutral-900 transition-colors',
          open
            ? 'border-neutral-400 dark:border-neutral-600'
            : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700',
        )}
        onClick={() => {
          setOpen(true)
          inputRef.current?.focus()
        }}
        onKeyDown={() => {
          // Inner input handles keyboard; wrapper click only exists to
          // capture clicks on the whitespace around chips so focus shifts.
        }}
        role="presentation"
      >
        <MagnifyingGlass className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
        <div className="flex items-center gap-1 flex-wrap min-w-0 flex-1">
          {filters.map((f) => (
            <span
              key={f.id}
              className="inline-flex items-center gap-1 h-5 pl-1.5 pr-0.5 rounded bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-[11.5px] font-mono text-neutral-800 dark:text-neutral-200"
            >
              <span>{f.column}</span>
              <span className="text-neutral-500 dark:text-neutral-400">{OP_SYMBOL[f.op]}</span>
              {!NO_VALUE_OPS.has(f.op) && <span>{f.value}</span>}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  removeFilter(f.id)
                }}
                className="w-3.5 h-3.5 rounded-sm flex items-center justify-center text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 cursor-pointer"
                aria-label={t('records.search.removeFilter')}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
          {draft.phase !== 'idle' && (
            <span className="inline-flex items-center gap-1.5 h-5 pl-1.5 pr-1 rounded bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-[11.5px] font-mono text-neutral-800 dark:text-neutral-200">
              <span>{draft.column}</span>
              {draft.phase === 'value' && (
                <>
                  <span className="text-neutral-500 dark:text-neutral-400">
                    {OP_SYMBOL[draft.op]}
                  </span>
                  <span className="text-neutral-900 dark:text-neutral-100 whitespace-pre">
                    {input}
                  </span>
                </>
              )}
              <span
                aria-hidden="true"
                className="caret-blink inline-block w-[1.5px] h-[11px] bg-neutral-700 dark:bg-neutral-200 align-middle"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation()
                  setDraft({ phase: 'idle' })
                  setInput('')
                  inputRef.current?.focus()
                }}
                className="ml-0.5 w-3.5 h-3.5 rounded-sm flex items-center justify-center text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 cursor-pointer"
                aria-label={t('records.search.removeFilter')}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          )}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKey}
            placeholder={filters.length === 0 && draft.phase === 'idle' ? placeholder : ''}
            className={clsx(
              'flex-1 min-w-[120px] h-6 bg-transparent border-0 outline-none text-[12.5px] placeholder:text-neutral-400',
              draft.phase !== 'idle'
                ? 'text-transparent caret-transparent select-none w-0 min-w-0 flex-none'
                : 'text-neutral-900 dark:text-neutral-100',
            )}
          />
        </div>
        {aiBusy && (
          <Sparkle className="w-3.5 h-3.5 text-violet-500 shrink-0 animate-pulse" weight="fill" />
        )}
      </div>

      {showDropdown && (
        <div
          className="absolute left-0 top-9 z-30 w-[340px] max-h-[320px] overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-[0_8px_24px_rgba(0,0,0,0.08)] py-1"
          onMouseDown={(e) => {
            // Keep input focus when clicking inside the dropdown.
            e.preventDefault()
          }}
        >
          {draft.phase === 'idle' && (
            <>
              {matchingColumns.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => pickColumn(c)}
                  className="w-full text-left px-3 py-1.5 text-[13px] font-mono text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer flex items-center justify-between gap-2"
                >
                  <span>{c}</span>
                  <span className="text-[10.5px] text-neutral-400 font-sans">
                    {colKinds[c] ?? 'string'}
                  </span>
                </button>
              ))}
              {canAskAi && (
                <button
                  type="button"
                  disabled={aiBusy}
                  onClick={() => {
                    void onAskAi(input.trim()).then(() => setInput(''))
                  }}
                  className="w-full text-left px-3 py-2 text-[13px] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer truncate disabled:opacity-60 disabled:cursor-default"
                >
                  {aiBusy
                    ? t('records.search.askingAi')
                    : t('records.search.askAi', { query: input.trim() })}
                </button>
              )}
              {matchingColumns.length === 0 && !canAskAi && (
                <div className="px-3 py-2 text-[12px] text-neutral-400">
                  {t('records.search.noColumnMatch')}
                </div>
              )}
            </>
          )}

          {draft.phase === 'column' && (
            <div>
              {opGroupsForKind(draft.kind, t).map((group) => (
                <div key={group.title} className="py-1.5">
                  <div className="px-3 pt-1.5 pb-1 text-[10.5px] uppercase tracking-[0.08em] text-neutral-400 font-semibold">
                    {group.title}
                  </div>
                  {group.ops.map((op) => (
                    <button
                      key={op}
                      type="button"
                      onClick={() => pickOp(op)}
                      className="w-full text-left px-3 py-2 text-[13px] text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer flex items-center justify-between gap-2"
                    >
                      <span>{t(`records.search.op.${op}`)}</span>
                      <span className="inline-flex items-center justify-center min-w-[26px] h-[18px] px-1.5 rounded bg-neutral-100 dark:bg-neutral-800 text-[10.5px] font-mono text-neutral-500 dark:text-neutral-400">
                        {OP_SYMBOL[op]}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {draft.phase === 'value' && (
            <div className="px-3 py-2 text-[12px] text-neutral-500">
              {t('records.search.typeValueHint', {
                column: draft.column,
                op: OP_SYMBOL[draft.op],
              })}
            </div>
          )}
        </div>
      )}

      {aiError && (
        <div className="absolute left-0 top-9 z-30 w-full rounded-md border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
          {aiError}
        </div>
      )}
    </div>
  )
}
