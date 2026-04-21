import { clsx } from 'clsx'

interface SegmentedProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}

export function Segmented<T extends string>({ value, onChange, options }: SegmentedProps<T>) {
  return (
    <div className="inline-flex items-center rounded border border-neutral-300 bg-white p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={clsx(
            'px-3 py-1 text-[15px] rounded-sm transition-colors',
            value === opt.value
              ? 'bg-neutral-900 text-white'
              : 'text-neutral-600 hover:bg-neutral-100',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
