import { MagnifyingGlass, Play } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { type ReactNode, useState } from 'react'
import type { PrimitiveCatalogEntry, PrimitiveSpec } from '@/lib/primitives/types'

type C = { spec: PrimitiveSpec; children?: ReactNode }

// ─── form ────────────────────────────────────────────────────────────────

interface FormField {
  name: string
  label?: string
  kind: 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date'
  placeholder?: string
  required?: boolean
  options?: string[] // for select
}

export function Form({ spec }: C) {
  const fields = (Array.isArray(spec.config?.fields) ? spec.config.fields : []) as FormField[]
  const submitLabel = str(spec.config?.submitLabel, 'Submit')
  const [values, setValues] = useState<Record<string, unknown>>({})

  const update = (k: string, v: unknown) => setValues((prev) => ({ ...prev, [k]: v }))

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        // eslint-disable-next-line no-console
        console.log('[form submit]', values)
      }}
      className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3.5 space-y-2.5"
    >
      {fields.map((f) => (
        <div key={f.name}>
          <label className="block text-[12px] font-medium text-neutral-600 dark:text-neutral-400 mb-1">
            {f.label ?? f.name}
            {f.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          {renderField(f, values[f.name], (v) => update(f.name, v))}
        </div>
      ))}
      <div className="pt-1">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-neutral-900 text-white text-[13px] hover:bg-neutral-700"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

function renderField(f: FormField, value: unknown, onChange: (v: unknown) => void) {
  const common =
    'w-full px-2.5 py-1.5 text-[13px] rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300'
  switch (f.kind) {
    case 'text':
      return (
        <input
          type="text"
          value={String(value ?? '')}
          placeholder={f.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={common}
        />
      )
    case 'number':
      return (
        <input
          type="number"
          value={value === undefined || value === null ? '' : Number(value)}
          placeholder={f.placeholder}
          onChange={(e) => onChange(Number(e.target.value))}
          className={clsx(common, 'font-mono')}
        />
      )
    case 'textarea':
      return (
        <textarea
          value={String(value ?? '')}
          placeholder={f.placeholder}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
          className={clsx(common, 'resize-none')}
        />
      )
    case 'select':
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={common}
        >
          <option value="">—</option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    case 'checkbox':
      return (
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="text-[13px]">{f.placeholder ?? ''}</span>
        </label>
      )
    case 'date':
      return (
        <input
          type="date"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={clsx(common, 'font-mono')}
        />
      )
    default:
      return null
  }
}

export const formCatalog: PrimitiveCatalogEntry = {
  name: 'form',
  summary: 'Schema-driven input form.',
  description:
    'Declare fields with `name`, `label`, `kind`. On submit, the form emits `submit` event with the gathered values (currently logged; wire to an action for real mutations).',
  configSchema: {
    fields:
      "{name, label?, kind: 'text'|'number'|'textarea'|'select'|'checkbox'|'date', options?: string[], placeholder?, required?}[]",
    submitLabel: 'string?',
  },
  accepts_children: false,
  handlers: ['submit'],
  examples: [
    {
      primitive: 'form',
      config: {
        submitLabel: 'Add customer',
        fields: [
          { name: 'name', label: 'Name', kind: 'text', required: true },
          { name: 'email', label: 'Email', kind: 'text' },
          { name: 'stage', label: 'Stage', kind: 'select', options: ['prospect', 'qualified', 'won'] },
        ],
      },
    },
  ],
}

// ─── filter-bar ──────────────────────────────────────────────────────────

interface FilterField {
  name: string
  label?: string
  kind: 'select' | 'text'
  options?: string[]
}

export function FilterBar({ spec }: C) {
  const fields = (Array.isArray(spec.config?.fields) ? spec.config.fields : []) as FilterField[]
  const [values, setValues] = useState<Record<string, string>>({})
  return (
    <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/40">
      {fields.map((f) => (
        <div key={f.name} className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            {f.label ?? f.name}
          </span>
          {f.kind === 'select' ? (
            <select
              value={values[f.name] ?? ''}
              onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
              className="px-2 py-0.5 text-[12px] rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
            >
              <option value="">All</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values[f.name] ?? ''}
              onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
              className="px-2 py-0.5 text-[12px] rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 font-mono w-24"
            />
          )}
        </div>
      ))}
    </div>
  )
}

export const filterBarCatalog: PrimitiveCatalogEntry = {
  name: 'filter-bar',
  summary: 'Row of filter controls that bind to a target primitive.',
  description:
    'Use above a `table` or `list` to drive server- or client-side filtering. Emits `value` (Record<name, string>) for upstream binding.',
  configSchema: { fields: "{name, label?, kind: 'select'|'text', options?: string[]}[]" },
  accepts_children: false,
  emits: ['value'],
  examples: [
    {
      primitive: 'filter-bar',
      config: {
        fields: [
          { name: 'stage', kind: 'select', options: ['prospect', 'qualified', 'won'] },
          { name: 'q', label: 'Search', kind: 'text' },
        ],
      },
    },
  ],
}

// ─── search ──────────────────────────────────────────────────────────────

export function Search({ spec }: C) {
  const placeholder = str(spec.config?.placeholder, 'Search…')
  const [q, setQ] = useState('')
  return (
    <div className="relative">
      <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-400" />
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-8 pr-3 py-1.5 text-[13px] rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
      />
    </div>
  )
}

export const searchCatalog: PrimitiveCatalogEntry = {
  name: 'search',
  summary: 'Search input with a leading icon.',
  description: 'Free-text input. Emits `value` (string).',
  configSchema: { placeholder: 'string?' },
  accepts_children: false,
  emits: ['value'],
  examples: [{ primitive: 'search', config: { placeholder: 'Find customer…' } }],
}

// ─── button ──────────────────────────────────────────────────────────────

export function Button({ spec }: C) {
  const label = str(spec.config?.label, 'Action')
  const variant = str(spec.config?.variant, 'primary') as 'primary' | 'outline' | 'ghost'
  const icon = spec.config?.icon === 'play' ? <Play weight="fill" className="w-3.5 h-3.5" /> : null
  return (
    <button
      type="button"
      onClick={() => {
        // eslint-disable-next-line no-console
        console.log('[button click]', spec.id ?? label)
      }}
      className={clsx(
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[13px] font-medium',
        variant === 'primary' && 'bg-neutral-900 text-white hover:bg-neutral-700',
        variant === 'outline' &&
          'border border-neutral-300 dark:border-neutral-700 text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800',
        variant === 'ghost' && 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

export const buttonCatalog: PrimitiveCatalogEntry = {
  name: 'button',
  summary: 'Clickable action button.',
  description:
    'Fires an event when clicked. Wire to `on.click` → action (delegate_to, sql_exec, open_block, …).',
  configSchema: {
    label: 'string',
    variant: "'primary' | 'outline' | 'ghost' (default: primary)",
    icon: "'play' | null",
  },
  accepts_children: false,
  handlers: ['click'],
  examples: [
    {
      primitive: 'button',
      config: { label: 'Session sync', variant: 'primary', icon: 'play' },
      on: { click: { action: 'delegate_to', params: { agent: 'Lead', task: 'Sync CRM' } } },
    },
  ],
}

// ─── helpers ─────────────────────────────────────────────────────────────

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}
