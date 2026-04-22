import { FileText, Info, Warning } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import type { PrimitiveCatalogEntry, PrimitiveSpec } from '@/lib/primitives/types'

type C = { spec: PrimitiveSpec; children?: ReactNode }

// ─── markdown (light) ────────────────────────────────────────────────────

/**
 * Minimal markdown — headings, bold, italic, code, list, paragraphs.
 * Not a full parser; intentionally thin so there are no external deps and no XSS surface.
 */
export function Markdown({ spec }: C) {
  const text = str(spec.config?.text, '')
  return (
    <div className="prose-mini text-[14px] leading-relaxed text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap">
      {renderMini(text)}
    </div>
  )
}

function renderMini(text: string): ReactNode[] {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  lines.forEach((line, i) => {
    const key = `${i}-${line.slice(0, 8)}`
    if (/^### /.test(line)) {
      out.push(<h3 key={key} className="text-[15px] font-semibold mt-2">{line.slice(4)}</h3>)
    } else if (/^## /.test(line)) {
      out.push(<h2 key={key} className="text-[16px] font-semibold mt-3">{line.slice(3)}</h2>)
    } else if (/^# /.test(line)) {
      out.push(<h1 key={key} className="text-[18px] font-bold mt-3">{line.slice(2)}</h1>)
    } else if (/^- /.test(line)) {
      out.push(
        <div key={key} className="flex gap-2">
          <span className="text-neutral-400">•</span>
          <span>{inline(line.slice(2))}</span>
        </div>,
      )
    } else if (line.trim() === '') {
      out.push(<div key={key} className="h-2" />)
    } else {
      out.push(<div key={key}>{inline(line)}</div>)
    }
  })
  return out
}

function inline(s: string): ReactNode {
  // very light inline parse: **bold**, *italic*, `code`
  const parts: ReactNode[] = []
  let rest = s
  let i = 0
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/
  while (rest.length > 0) {
    const m = rest.match(re)
    if (!m || m.index === undefined) {
      parts.push(<span key={`t-${i}`}>{rest}</span>)
      break
    }
    if (m.index > 0) parts.push(<span key={`t-${i}`}>{rest.slice(0, m.index)}</span>)
    const tok = m[0]
    if (tok.startsWith('**')) parts.push(<strong key={`s-${i}`}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('*')) parts.push(<em key={`e-${i}`}>{tok.slice(1, -1)}</em>)
    else parts.push(<code key={`c-${i}`} className="px-1 py-0.5 text-[12px] bg-neutral-100 dark:bg-neutral-800 rounded">{tok.slice(1, -1)}</code>)
    rest = rest.slice(m.index + tok.length)
    i += 1
  }
  return <>{parts}</>
}

export const markdownCatalog: PrimitiveCatalogEntry = {
  name: 'markdown',
  summary: 'Rich text (markdown). Headings, lists, bold/italic/code.',
  description:
    'Lightweight markdown. Use for notes, instructions, and any prose content. NOT suitable for complex layouts — compose primitives for those.',
  configSchema: { text: 'string' },
  accepts_children: false,
  examples: [
    {
      primitive: 'markdown',
      config: {
        text: '# Weekly goals\n\n- Close **3 deals**\n- Ship `v1.2`\n- Review pipeline',
      },
    },
  ],
}

// ─── code ────────────────────────────────────────────────────────────────

export function Code({ spec }: C) {
  const text = str(spec.config?.text, '')
  const language = str(spec.config?.language, '')
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-950 dark:bg-neutral-950 overflow-hidden">
      {language && (
        <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-neutral-500 border-b border-neutral-800 bg-neutral-900">
          {language}
        </div>
      )}
      <pre className="px-3 py-2.5 text-[12px] text-neutral-100 overflow-x-auto">
        <code>{text}</code>
      </pre>
    </div>
  )
}

export const codeCatalog: PrimitiveCatalogEntry = {
  name: 'code',
  summary: 'Monospace code block with optional language label.',
  description:
    'For showing JSON, SQL, source snippets. No syntax highlighting — just monospace + dark theme.',
  configSchema: { text: 'string', language: 'string? (label only)' },
  accepts_children: false,
  examples: [
    {
      primitive: 'code',
      config: { language: 'sql', text: 'SELECT id, name FROM customer\nWHERE stage = "won"' },
    },
  ],
}

// ─── image ───────────────────────────────────────────────────────────────

export function Image({ spec }: C) {
  const src = str(spec.config?.src, '')
  const alt = str(spec.config?.alt, '')
  const caption = str(spec.config?.caption, '')
  if (!src) return null
  return (
    <figure className="rounded-md overflow-hidden border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="w-full object-contain max-h-[480px]" />
      {caption && <figcaption className="px-3 py-1.5 text-[11px] text-neutral-500 border-t border-neutral-200 dark:border-neutral-800">{caption}</figcaption>}
    </figure>
  )
}

export const imageCatalog: PrimitiveCatalogEntry = {
  name: 'image',
  summary: 'Static image with optional caption.',
  description: 'Use for diagrams, screenshots, photos. `src` can be a URL or a data URI.',
  configSchema: { src: 'string (URL or data URI)', alt: 'string?', caption: 'string?' },
  accepts_children: false,
  examples: [
    { primitive: 'image', config: { src: '/hero.png', alt: 'Hero', caption: 'Q3 campaign' } },
  ],
}

// ─── file-viewer ─────────────────────────────────────────────────────────

export function FileViewer({ spec }: C) {
  const name = str(spec.config?.name, 'untitled')
  const src = str(spec.config?.src, '')
  const kind = str(spec.config?.kind, 'auto')
  const text = str(spec.config?.text, '')
  const type = inferType(name, kind)

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50">
        <FileText className="w-3.5 h-3.5 text-neutral-500" />
        <span className="text-[12px] font-mono truncate">{name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-neutral-400">{type}</span>
      </div>
      <div className="p-0">
        {type === 'pdf' && src && (
          <iframe src={src} title={name} className="w-full" style={{ height: 480 }} />
        )}
        {type === 'image' && src && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={src} alt={name} className="w-full object-contain max-h-[480px]" />
        )}
        {type === 'text' && (
          <pre className="px-3 py-2 text-[12px] text-neutral-800 dark:text-neutral-200 overflow-x-auto max-h-[480px]">
            {text || '(empty)'}
          </pre>
        )}
        {type === 'binary' && (
          <div className="p-6 text-[13px] text-neutral-500 text-center">
            Preview unavailable for this file kind.
          </div>
        )}
      </div>
    </div>
  )
}

function inferType(name: string, kindConfig: string): 'pdf' | 'image' | 'text' | 'binary' {
  if (kindConfig === 'pdf' || kindConfig === 'image' || kindConfig === 'text' || kindConfig === 'binary')
    return kindConfig
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return 'image'
  if (/\.(txt|md|csv|tsv|json|ya?ml|log|ini|conf)$/.test(lower)) return 'text'
  return 'binary'
}

export const fileViewerCatalog: PrimitiveCatalogEntry = {
  name: 'file-viewer',
  summary: 'Preview PDF / image / text files.',
  description:
    'For PDFs provide `src` (URL). For images provide `src`. For text provide `text` inline. For anything else, falls back to a "preview unavailable" stub.',
  configSchema: {
    name: 'string (filename)',
    src: 'string? (URL; for pdf/image)',
    text: 'string? (for text files)',
    kind: "'pdf'|'image'|'text'|'binary'|'auto' (default: infer from name)",
  },
  accepts_children: false,
  examples: [
    { primitive: 'file-viewer', config: { name: 'contract.pdf', src: '/files/contract.pdf' } },
    { primitive: 'file-viewer', config: { name: 'notes.md', kind: 'text', text: '# Meeting' } },
  ],
}

// ─── callout ─────────────────────────────────────────────────────────────

export function Callout({ spec }: C) {
  const kind = str(spec.config?.kind, 'info') as 'info' | 'warning' | 'success' | 'danger'
  const title = str(spec.config?.title, '')
  const body = str(spec.config?.body, '')
  const palette: Record<string, { bg: string; fg: string; border: string; Icon: typeof Info }> = {
    info: { bg: 'bg-sky-50 dark:bg-sky-950/30', fg: 'text-sky-800 dark:text-sky-200', border: 'border-sky-200 dark:border-sky-900', Icon: Info },
    warning: { bg: 'bg-amber-50 dark:bg-amber-950/30', fg: 'text-amber-800 dark:text-amber-200', border: 'border-amber-200 dark:border-amber-900', Icon: Warning },
    success: { bg: 'bg-emerald-50 dark:bg-emerald-950/30', fg: 'text-emerald-800 dark:text-emerald-200', border: 'border-emerald-200 dark:border-emerald-900', Icon: Info },
    danger: { bg: 'bg-red-50 dark:bg-red-950/30', fg: 'text-red-800 dark:text-red-200', border: 'border-red-200 dark:border-red-900', Icon: Warning },
  }
  const p = palette[kind] ?? palette.info
  const I = p.Icon
  return (
    <div className={clsx('rounded-md border p-3 flex items-start gap-2', p.bg, p.border, p.fg)}>
      <I className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0">
        {title && <div className="font-semibold text-[13px]">{title}</div>}
        {body && <div className="text-[13px] leading-relaxed mt-0.5">{body}</div>}
      </div>
    </div>
  )
}

export const calloutCatalog: PrimitiveCatalogEntry = {
  name: 'callout',
  summary: 'Highlighted info/warning/success/danger banner.',
  description:
    'Use sparingly — for important side-notes, errors, or calls to action. Color is reserved for `kind`.',
  configSchema: { kind: "'info'|'warning'|'success'|'danger'", title: 'string?', body: 'string' },
  accepts_children: false,
  examples: [
    { primitive: 'callout', config: { kind: 'warning', title: 'Heads up', body: 'Deal closes Friday.' } },
  ],
}

// ─── badge ───────────────────────────────────────────────────────────────

export function Badge({ spec }: C) {
  const label = str(spec.config?.label, '')
  const tone = str(spec.config?.tone, 'neutral')
  const map: Record<string, string> = {
    neutral: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
    blue: 'bg-blue-100 text-blue-700',
    amber: 'bg-amber-100 text-amber-800',
    emerald: 'bg-emerald-100 text-emerald-700',
    red: 'bg-red-100 text-red-700',
    sky: 'bg-sky-100 text-sky-700',
  }
  return (
    <span className={clsx('inline-block px-1.5 py-0.5 rounded-sm text-[11px] font-medium uppercase tracking-wider', map[tone] ?? map.neutral)}>
      {label}
    </span>
  )
}

export const badgeCatalog: PrimitiveCatalogEntry = {
  name: 'badge',
  summary: 'Small labeled pill.',
  description: 'Inline status/category marker. Pick `tone` from the defined palette; do not use arbitrary colors.',
  configSchema: { label: 'string', tone: "'neutral'|'blue'|'amber'|'emerald'|'red'|'sky'" },
  accepts_children: false,
  examples: [{ primitive: 'badge', config: { label: 'Active', tone: 'emerald' } }],
}

// ─── progress ────────────────────────────────────────────────────────────

export function Progress({ spec }: C) {
  const value = num(spec.config?.value, 0)
  const max = num(spec.config?.max, 100)
  const label = str(spec.config?.label, '')
  const pct = Math.max(0, Math.min(100, (value / Math.max(max, 1)) * 100))
  return (
    <div className="w-full">
      {label && (
        <div className="flex items-center justify-between text-[11px] text-neutral-500 mb-1">
          <span>{label}</span>
          <span className="font-mono tabular-nums">{value}/{max}</span>
        </div>
      )}
      <div className="w-full h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
        <div
          className="h-full bg-neutral-800 dark:bg-neutral-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export const progressCatalog: PrimitiveCatalogEntry = {
  name: 'progress',
  summary: 'Horizontal progress bar with optional label.',
  description: 'Shows completion ratio. Fill is monochrome.',
  configSchema: { value: 'number', max: 'number (default 100)', label: 'string?' },
  accepts_children: false,
  examples: [{ primitive: 'progress', config: { label: 'Q3 quota', value: 68, max: 100 } }],
}

// ─── empty-state ─────────────────────────────────────────────────────────

export function EmptyState({ spec }: C) {
  const title = str(spec.config?.title, 'Nothing here')
  const body = str(spec.config?.body, '')
  return (
    <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 py-8 px-4 text-center">
      <div className="text-[14px] font-medium text-neutral-700 dark:text-neutral-300">{title}</div>
      {body && <div className="text-[12px] text-neutral-500 mt-1">{body}</div>}
    </div>
  )
}

export const emptyStateCatalog: PrimitiveCatalogEntry = {
  name: 'empty-state',
  summary: 'Placeholder when a section has no content.',
  description: 'Use when a data source returns zero items. Keep text brief and neutral.',
  configSchema: { title: 'string', body: 'string?' },
  accepts_children: false,
  examples: [
    { primitive: 'empty-state', config: { title: 'No tasks yet', body: 'Create one to get started.' } },
  ],
}

// ─── iframe (escape hatch) ───────────────────────────────────────────────

export function IFrame({ spec }: C) {
  const src = str(spec.config?.src, '')
  const height = num(spec.config?.height, 360)
  const title = str(spec.config?.title, 'Embedded content')
  if (!src) return null
  return (
    <iframe
      src={src}
      title={title}
      className="w-full rounded-md border border-neutral-200 dark:border-neutral-800"
      style={{ height }}
      sandbox="allow-same-origin allow-scripts allow-popups"
    />
  )
}

export const iframeCatalog: PrimitiveCatalogEntry = {
  name: 'iframe',
  summary: 'Sandboxed embed for a URL (escape hatch).',
  description:
    'Use ONLY when no other primitive fits: external docs, public embeds, etc. Sandboxed for safety.',
  configSchema: { src: 'string (URL)', height: 'number? (px)', title: 'string?' },
  accepts_children: false,
  examples: [{ primitive: 'iframe', config: { src: 'https://example.com', height: 400 } }],
}

// ─── helpers ─────────────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}
