import { clsx } from 'clsx'
import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'outline'
type Size = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const variants: Record<Variant, string> = {
  primary: 'bg-neutral-900 text-white hover:bg-neutral-700',
  ghost: 'bg-transparent hover:bg-neutral-100 text-neutral-700',
  outline: 'border border-neutral-300 bg-white hover:bg-neutral-50 text-neutral-800',
}

const sizes: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-[15px] rounded-sm',
  md: 'px-3 py-1.5 text-[15px] rounded',
}

export function Button({
  variant = 'outline',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={clsx(
        'inline-flex items-center gap-1.5 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {children}
    </button>
  )
}
