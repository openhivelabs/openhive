import { DotsSixVertical, PencilSimple, Trash } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type { DragEvent, ReactNode } from 'react'

export interface BlockProps {
  id: string
  title: string
  subtitle?: string
  colSpan?: 1 | 2 | 3 | 4
  rowSpan?: 1 | 2 | 3 | 4
  editing?: boolean
  dragOver?: boolean
  dragging?: boolean
  onRemove?: () => void
  onEdit?: () => void
  onDragStart?: (id: string, e: DragEvent<HTMLElement>) => void
  onDragOver?: (id: string, e: DragEvent<HTMLElement>) => void
  onDragLeave?: (id: string, e: DragEvent<HTMLElement>) => void
  onDrop?: (id: string, e: DragEvent<HTMLElement>) => void
  onDragEnd?: (id: string, e: DragEvent<HTMLElement>) => void
  children: ReactNode
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
  colSpan = 1,
  rowSpan = 1,
  editing = false,
  dragOver = false,
  dragging = false,
  onRemove,
  onEdit,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  children,
}: BlockProps) {
  return (
    <section
      draggable={editing}
      onDragStart={editing && onDragStart ? (e) => onDragStart(id, e) : undefined}
      onDragOver={editing && onDragOver ? (e) => onDragOver(id, e) : undefined}
      onDragLeave={editing && onDragLeave ? (e) => onDragLeave(id, e) : undefined}
      onDrop={editing && onDrop ? (e) => onDrop(id, e) : undefined}
      onDragEnd={editing && onDragEnd ? (e) => onDragEnd(id, e) : undefined}
      className={clsx(
        'relative rounded-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 flex flex-col min-h-0 overflow-hidden transition',
        dragging && 'opacity-40',
        dragOver && 'ring-2 ring-neutral-400 dark:ring-neutral-500 ring-offset-2 ring-offset-neutral-50 dark:ring-offset-neutral-950',
        COL[colSpan],
        ROW[rowSpan],
      )}
    >
      <header className="h-9 shrink-0 px-2 flex items-center gap-2 border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50">
        {editing && (
          <span
            aria-label="Drag"
            title="드래그해서 옮기기"
            className="w-6 h-6 flex items-center justify-center rounded-sm text-neutral-500 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-50 hover:bg-white/70 dark:hover:bg-neutral-800 cursor-grab active:cursor-grabbing"
          >
            <DotsSixVertical weight="bold" className="w-4 h-4" />
          </span>
        )}
        <span className="text-[14px] font-medium text-neutral-800 dark:text-neutral-100 truncate">
          {title}
        </span>
        {subtitle && (
          <span className="text-[14px] text-neutral-400 truncate">· {subtitle}</span>
        )}
        <div className="flex-1" />
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
            title="삭제"
            className="h-6 w-6 rounded-sm flex items-center justify-center text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 cursor-pointer"
          >
            <Trash className="w-3.5 h-3.5" />
          </button>
        )}
      </header>
      <div className="flex-1 overflow-auto">{children}</div>
    </section>
  )
}
