import type { ReactNode } from 'react'

/** Page-level empty state. Subtle, centered, single-line.
 *  Caller controls icon size (typically w-10 h-10) via className on the passed icon. */
export function PageEmptyState({
  icon,
  children,
}: {
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex-1 h-full min-h-[160px] flex items-center justify-center text-[13px] text-neutral-400">
      <div className="text-center">
        <div className="mb-2 flex justify-center text-neutral-300 dark:text-neutral-700">
          {icon}
        </div>
        {children}
      </div>
    </div>
  )
}
