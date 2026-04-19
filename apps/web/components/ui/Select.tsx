import { CaretDown } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type { SelectHTMLAttributes } from 'react'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}

export function Select({ label, className, children, ...rest }: SelectProps) {
  return (
    <div className="relative inline-flex items-center">
      {label && <span className="text-xs text-neutral-500 mr-2">{label}</span>}
      <select
        {...rest}
        className={clsx(
          'appearance-none pl-3 pr-8 py-1.5 text-sm rounded-lg border border-neutral-300 bg-white hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-300',
          className,
        )}
      >
        {children}
      </select>
      <CaretDown className="pointer-events-none absolute right-2 w-3.5 h-3.5 text-neutral-500" />
    </div>
  )
}
