import {
  DotsSixVertical,
  DotsThreeVertical,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'

interface BlockProps {
  id: string
  title: string
  subtitle?: string
  colSpan?: 1 | 2 | 3 | 4 | 5 | 6
  rowSpan?: 1 | 2 | 3 | 4 | 5 | 6
  /** 1-based grid placement. When omitted the panel uses auto-flow. */
  col?: number
  row?: number
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
  5: 'col-span-5',
  6: 'col-span-6',
}

const ROW: Record<NonNullable<BlockProps['rowSpan']>, string> = {
  1: 'row-span-1',
  2: 'row-span-2',
  3: 'row-span-3',
  4: 'row-span-4',
  5: 'row-span-5',
  6: 'row-span-6',
}

export function Block({
  id,
  title,
  subtitle,
  colSpan = 1,
  rowSpan = 1,
  col,
  row,
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
  const t = useT()
  // Drag start fires only when the user actually grabs the handle. The
  // section itself is not draggable so a stray click on body content can't
  // accidentally pick the panel up.
  const [grabbed, setGrabbed] = useState(false)
  // Explicit grid-column / grid-row when col/row are set (free placement);
  // otherwise plain `col-span-X` / `row-span-X` classes (auto-flow).
  const hasPosition = col !== undefined && row !== undefined
  const placementStyle = hasPosition
    ? {
        gridColumn: `${col} / span ${colSpan}`,
        gridRow: `${row} / span ${rowSpan}`,
      }
    : undefined
  return (
    <section
      draggable={grabbed}
      onDragStart={onDragStart ? (e) => onDragStart(id, e) : undefined}
      onDragOver={onDragOver ? (e) => onDragOver(id, e) : undefined}
      onDragLeave={onDragLeave ? (e) => onDragLeave(id, e) : undefined}
      onDrop={onDrop ? (e) => onDrop(id, e) : undefined}
      onDragEnd={(e) => {
        setGrabbed(false)
        onDragEnd?.(id, e)
      }}
      style={placementStyle}
      className={clsx(
        'relative rounded-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 flex flex-col min-h-0 overflow-hidden transition',
        dragging && 'opacity-40',
        dragOver && 'ring-2 ring-neutral-400 dark:ring-neutral-500 ring-offset-2 ring-offset-neutral-50 dark:ring-offset-neutral-950',
        !hasPosition && COL[colSpan],
        !hasPosition && ROW[rowSpan],
      )}
    >
      <header className="h-9 shrink-0 px-2 flex items-center gap-2 border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50">
        <span
          aria-label={t('dashboard.dragToMove')}
          title={t('dashboard.dragToMove')}
          onMouseDown={() => setGrabbed(true)}
          onMouseUp={() => setGrabbed(false)}
          onTouchStart={() => setGrabbed(true)}
          onTouchEnd={() => setGrabbed(false)}
          className="w-6 h-6 flex items-center justify-center rounded-sm text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-100 hover:bg-white/70 dark:hover:bg-neutral-800 cursor-grab active:cursor-grabbing"
        >
          <DotsSixVertical weight="bold" className="w-4 h-4" />
        </span>
        <span className="text-[14px] font-medium text-neutral-800 dark:text-neutral-100 truncate">
          {title}
        </span>
        {subtitle && (
          <span className="text-[14px] text-neutral-400 truncate">· {subtitle}</span>
        )}
        <div className="flex-1" />
        {(onEdit || onRemove) && (
          <BlockMenu onEdit={onEdit} onRemove={onRemove} />
        )}
      </header>
      <div className="flex-1 overflow-hidden">{children}</div>
    </section>
  )
}

function BlockMenu({
  onEdit,
  onRemove,
}: {
  onEdit?: () => void
  onRemove?: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('dashboard.moreActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-6 w-6 rounded-sm flex items-center justify-center text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 cursor-pointer"
      >
        <DotsThreeVertical weight="bold" className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-7 z-10 min-w-[120px] py-1 rounded-sm bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 shadow-md"
        >
          {onEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onEdit()
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
            >
              <PencilSimple className="w-3.5 h-3.5" />
              {t('dashboard.edit')}
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onRemove()
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
            >
              <Trash className="w-3.5 h-3.5" />
              {t('dashboard.delete')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
