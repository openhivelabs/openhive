'use client'

import { clsx } from 'clsx'
import { type ReactNode, useState } from 'react'
import type { PrimitiveCatalogEntry, PrimitiveSpec } from '@/lib/primitives/types'

type C = { spec: PrimitiveSpec; children?: ReactNode }

// ─── rows ────────────────────────────────────────────────────────────────

export function Rows({ spec, children }: C) {
  const gap = num(spec.config?.gap, 3)
  return <div className={clsx('flex flex-col', gapClass(gap))}>{children}</div>
}

export const rowsCatalog: PrimitiveCatalogEntry = {
  name: 'rows',
  summary: 'Stack children vertically.',
  description:
    'Top-to-bottom stack. Use as the default container for most blocks. Gap is in Tailwind spacing units (default 3 = 0.75rem).',
  configSchema: { gap: 'number (0..8)' },
  accepts_children: true,
  examples: [
    {
      primitive: 'rows',
      config: { gap: 3 },
      children: [{ primitive: 'markdown', config: { text: '# Hello' } }],
    },
  ],
}

// ─── columns ─────────────────────────────────────────────────────────────

export function Columns({ spec, children }: C) {
  const gap = num(spec.config?.gap, 3)
  return <div className={clsx('flex flex-row', gapClass(gap))}>{children}</div>
}

export const columnsCatalog: PrimitiveCatalogEntry = {
  name: 'columns',
  summary: 'Arrange children horizontally.',
  description:
    'Side-by-side layout. Children expand equally by default unless they have their own width. Use `grid` for more control over column sizes.',
  configSchema: { gap: 'number (0..8)' },
  accepts_children: true,
  examples: [
    {
      primitive: 'columns',
      children: [
        { primitive: 'kpi', config: { label: 'Users', value: 124 } },
        { primitive: 'kpi', config: { label: 'Revenue', value: '$12k' } },
      ],
    },
  ],
}

// ─── grid ────────────────────────────────────────────────────────────────

export function Grid({ spec, children }: C) {
  const cols = num(spec.config?.cols, 3)
  const gap = num(spec.config?.gap, 3)
  return (
    <div
      className={clsx('grid', gapClass(gap))}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  )
}

export const gridCatalog: PrimitiveCatalogEntry = {
  name: 'grid',
  summary: 'Responsive N-column grid.',
  description:
    'Arrange children in a fixed column count. Prefer `columns` for 2–3 items; use `grid` when you want uniform sizing across many items.',
  configSchema: { cols: 'number (1..12)', gap: 'number (0..8)' },
  accepts_children: true,
  examples: [
    {
      primitive: 'grid',
      config: { cols: 4 },
      children: [{ primitive: 'kpi', config: { label: 'A', value: 1 } }],
    },
  ],
}

// ─── card ────────────────────────────────────────────────────────────────

export function Card({ spec, children }: C) {
  const title = str(spec.config?.title, '')
  const subtitle = str(spec.config?.subtitle, '')
  return (
    <section className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3.5">
      {(title || subtitle) && (
        <header className="mb-2.5">
          {title && <h3 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100">{title}</h3>}
          {subtitle && <p className="text-[12px] text-neutral-500 mt-0.5">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  )
}

export const cardCatalog: PrimitiveCatalogEntry = {
  name: 'card',
  summary: 'Bordered container with optional title.',
  description:
    'Framed region for visually grouping content. Use when a subsection deserves emphasis.',
  configSchema: { title: 'string?', subtitle: 'string?' },
  accepts_children: true,
  examples: [
    {
      primitive: 'card',
      config: { title: 'Weekly metrics' },
      children: [{ primitive: 'kpi', config: { label: 'Signups', value: 42 } }],
    },
  ],
}

// ─── tabs ────────────────────────────────────────────────────────────────

export function Tabs({ spec, children }: C) {
  const labels = asStringArray(spec.config?.labels)
  const kids = wrapChildrenArray(children)
  const [active, setActive] = useState(0)
  return (
    <div className="flex flex-col">
      <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {labels.map((label, i) => (
          <button
            key={`${label}-${i}`}
            type="button"
            onClick={() => setActive(i)}
            className={clsx(
              'px-3 py-1.5 text-[13px] border-b-2 -mb-px',
              active === i
                ? 'border-neutral-900 dark:border-neutral-100 text-neutral-900 dark:text-neutral-100 font-medium'
                : 'border-transparent text-neutral-500 hover:text-neutral-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="pt-3">{kids[active] ?? null}</div>
    </div>
  )
}

export const tabsCatalog: PrimitiveCatalogEntry = {
  name: 'tabs',
  summary: 'Tabbed sections. labels[i] shows children[i].',
  description:
    'Switch between views. `labels` length must match child count. Each child is an independent sub-tree (often a card or rows).',
  configSchema: { labels: 'string[]' },
  accepts_children: true,
  examples: [
    {
      primitive: 'tabs',
      config: { labels: ['Overview', 'Details'] },
      children: [
        { primitive: 'markdown', config: { text: 'Overview' } },
        { primitive: 'markdown', config: { text: 'Details' } },
      ],
    },
  ],
}

// ─── accordion ───────────────────────────────────────────────────────────

export function Accordion({ spec, children }: C) {
  const items = asStringArray(spec.config?.items)
  const kids = wrapChildrenArray(children)
  return (
    <div className="divide-y divide-neutral-200 dark:divide-neutral-800 border-y border-neutral-200 dark:border-neutral-800">
      {items.map((label, i) => (
        <AccordionItem key={`${label}-${i}`} label={label}>
          {kids[i] ?? null}
        </AccordionItem>
      ))}
    </div>
  )
}

function AccordionItem({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2 py-2 flex items-center justify-between text-left text-[14px] font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
      >
        <span>{label}</span>
        <span className="text-neutral-400">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="px-2 pb-3">{children}</div>}
    </div>
  )
}

export const accordionCatalog: PrimitiveCatalogEntry = {
  name: 'accordion',
  summary: 'Collapsible sections — labels[i] expands to children[i].',
  description:
    'Reveal-on-click sections. Good for dense information where default collapsed is desired.',
  configSchema: { items: 'string[]' },
  accepts_children: true,
  examples: [
    {
      primitive: 'accordion',
      config: { items: ['FAQ 1', 'FAQ 2'] },
      children: [
        { primitive: 'markdown', config: { text: 'Answer 1' } },
        { primitive: 'markdown', config: { text: 'Answer 2' } },
      ],
    },
  ],
}

// ─── helpers ─────────────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? '')) : []
}
function wrapChildrenArray(children: ReactNode): ReactNode[] {
  if (!children) return []
  if (Array.isArray(children)) return children
  return [children]
}
function gapClass(g: number): string {
  const m: Record<number, string> = {
    0: 'gap-0', 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4',
    5: 'gap-5', 6: 'gap-6', 7: 'gap-7', 8: 'gap-8',
  }
  return m[g] ?? 'gap-3'
}
