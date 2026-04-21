'use client'

import {
  ArrowClockwise,
  CircleNotch,
  DotsSixVertical,
  PencilSimple,
  Trash,
  Warning,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { type DragEvent, type ReactNode, useState } from 'react'

export interface BlockProps {
  id: string
  title: string
  subtitle?: string
  icon?: ReactNode
  colSpan?: 1 | 2 | 3 | 4
  rowSpan?: 1 | 2 | 3 | 4
  editing?: boolean
  dragOver?: boolean
  dragging?: boolean
  onRemove?: () => void
  onEdit?: () => void
  /** Optional manual refresh (only shown when the panel has a binding). The
   *  handler returns a promise so the button can show a spinner. */
  onRefresh?: () => Promise<void> | void
  onDragStart?: (id: string, e: DragEvent<HTMLElement>) => void
  onDragOver?: (id: string, e: DragEvent<HTMLElement>) => void
  onDragLeave?: (id: string, e: DragEvent<HTMLElement>) => void
  onDrop?: (id: string, e: DragEvent<HTMLElement>) => void
  onDragEnd?: (id: string, e: DragEvent<HTMLElement>) => void
  /** Unix ms of the last cache refresh. When set, a subtle "live" chip with
   *  relative time shows in the header. */
  fetchedAt?: number | null
  /** When present, the header shows a red error chip (block still renders last-good data). */
  liveError?: string | null
  children: ReactNode
}

function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms)
  if (diff < 1000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ms).toLocaleString()
}

const COL: Record<NonNullable<BlockProps['colSpan']>, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-3',
  4: 'col-span-4',
}

const ROW: Record<NonNullable<BlockProps['rowSpan']>, string> = {
  1: 'row-span-1',
  2: 'row-span-2',
  3: 'row-span-3',
  4: 'row-span-4',
}

export function Block({
  id,
  title,
  subtitle,
  icon,
  colSpan = 1,
  rowSpan = 1,
  editing = false,
  dragOver = false,
  dragging = false,
  onRemove,
  onEdit,
  onRefresh,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  fetchedAt,
  liveError,
  children,
}: BlockProps) {
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section
      draggable={editing}
      onDragStart={editing && onDragStart ? (e) => onDragStart(id, e) : undefined}
      onDragOver={editing && onDragOver ? (e) => onDragOver(id, e) : undefined}
      onDragLeave={editing && onDragLeave ? (e) => onDragLeave(id, e) : undefined}
      onDrop={editing && onDrop ? (e) => onDrop(id, e) : undefined}
      onDragEnd={editing && onDragEnd ? (e) => onDragEnd(id, e) : undefined}
      className={clsx(
        'relative rounded-md bg-white dark:bg-neutral-900 border flex flex-col min-h-0 overflow-hidden transition',
        editing
          ? 'border-amber-300 dark:border-amber-700 shadow-[0_0_0_1px_rgba(251,191,36,0.15)]'
          : 'border-neutral-200 dark:border-neutral-800',
        dragging && 'opacity-40',
        dragOver && 'ring-2 ring-amber-500 ring-offset-2 ring-offset-neutral-50 dark:ring-offset-neutral-950',
        COL[colSpan],
        ROW[rowSpan],
      )}
    >
      <header
        className={clsx(
          'h-9 shrink-0 px-2 flex items-center gap-2 border-b',
          editing
            ? 'border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30'
            : 'border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50',
        )}
      >
        {editing && (
          <span
            aria-label="Drag"
            title="드래그해서 옮기기"
            className="w-6 h-6 flex items-center justify-center rounded-sm text-neutral-500 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-50 hover:bg-white/70 dark:hover:bg-neutral-800 cursor-grab active:cursor-grabbing"
          >
            <DotsSixVertical weight="bold" className="w-4 h-4" />
          </span>
        )}
        {icon && <span className="text-neutral-500 pl-0.5">{icon}</span>}
        <span className="text-[14px] font-medium text-neutral-800 dark:text-neutral-100 truncate">
          {title}
        </span>
        {subtitle && (
          <span className="text-[14px] text-neutral-400 truncate">· {subtitle}</span>
        )}
        <div className="flex-1" />
        {liveError && (
          <span
            title={liveError}
            className="inline-flex items-center gap-1 text-[11.5px] text-red-600 bg-red-50 dark:bg-red-950/40 px-1.5 py-0.5 rounded-sm font-mono truncate max-w-[180px]"
          >
            <Warning className="w-3 h-3" />
            error
          </span>
        )}
        {typeof fetchedAt === 'number' && fetchedAt > 0 && (
          <span
            title={`Last refreshed ${new Date(fetchedAt).toLocaleString()}`}
            className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300 font-mono"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {relativeTime(fetchedAt)}
          </span>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title="지금 새로고침"
            aria-label="Refresh panel"
            className="h-6 w-6 rounded-sm flex items-center justify-center text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200/70 dark:hover:bg-neutral-700 dark:hover:text-neutral-100 disabled:opacity-50 cursor-pointer"
          >
            {refreshing ? (
              <CircleNotch className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ArrowClockwise className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {editing && onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit panel"
            title="수정"
            className="h-6 px-1.5 rounded-sm text-[13px] flex items-center gap-1 text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-700 cursor-pointer"
          >
            <PencilSimple className="w-3.5 h-3.5" />
          </button>
        )}
        {editing && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove block"
            className="h-6 px-1.5 rounded-sm text-[14px] flex items-center gap-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 cursor-pointer"
          >
            <Trash className="w-3.5 h-3.5" />
            삭제
          </button>
        )}
      </header>
      <div className="flex-1 overflow-auto">{children}</div>
    </section>
  )
}
