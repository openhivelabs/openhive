/**
 * Frame Market — local catalog of shareable company / team / agent / panel
 * frames. Lives at `packages/frame-market/` inside this repo so the app
 * always ships with its catalog (no network, no env, no GitHub round-trip).
 *
 * Catalog layout (relative to packages/frame-market/):
 *   index.json                       { companies, teams, agents, panels }
 *   teams/<id>.openhive-frame.yaml
 *   agents/<id>.openhive-agent-frame.yaml
 *   companies/<id>.openhive-company.yaml   (bundles team frame ids)
 *   panels/<category>/<id>.openhive-panel-frame.yaml
 *                                         (PanelSpec template. Categories:
 *                                          kpi / chart / table / kanban /
 *                                          activity / note — extendable.)
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { packagesRoot } from './paths'

function catalogDir(): string {
  return path.join(packagesRoot(), 'frame-market')
}

export type MarketType = 'company' | 'team' | 'agent' | 'panel'

export interface MarketEntry {
  id: string
  type: MarketType
  name: string
  description: string
  tags: string[]
  author?: string
  /** type=team → agent_count from team frame (best-effort). */
  agent_count?: number
  /** type=company → bundled team frame ids. */
  teams?: string[]
  /** type=panel → category hint for grouping in the UI. */
  category?: string
  /** type=panel → size variants the frame author declared. Users can only
   *  pick from this list in the preview / size picker. First entry is the
   *  default. Omitted list → preview falls back to a single size. */
  sizes?: PanelSize[]
  /** type=panel → DDL to run at install time in its "blank" form. The
   *  install-time AI router inspects this alongside the current company
   *  schema and emits a plan (reuse / extend / standalone). */
  setup_sql?: string
  /** type=panel → static thumbnail spec for the modal. Renderer-agnostic;
   *  lets new panels ship with a preview without app code changes. */
  preview?: PanelPreview
}

export interface PanelSize {
  colSpan: 1 | 2 | 3 | 4
  rowSpan: 1 | 2 | 3 | 4
}

export type PanelPreview =
  | {
      kind: 'line'
      data: number[]
      subtitle?: string
      time_ranges?: number[]
      default_range?: number
    }
  | { kind: 'area'; data: number[]; subtitle?: string }
  | { kind: 'bar'; bars: { label: string; value: number }[]; subtitle?: string; format?: 'currency'; orientation?: 'vertical' | 'horizontal' }
  | { kind: 'pie'; slices: { label: string; value: number }[]; subtitle?: string }
  | {
      kind: 'kpi'
      value: string
      hint: string
      tone?: 'positive' | 'negative'
      subtitle?: string
      delta?: string
      target?: string
      progress?: number
    }
  | { kind: 'kanban'; columns: { label: string; cards: string[] }[]; subtitle?: string }
  | { kind: 'table'; columns: string[]; rows: string[][]; subtitle?: string }
  | { kind: 'heatmap'; rowLabels: string[]; colLabels: string[]; values: number[][]; subtitle?: string }
  | { kind: 'stat_row'; stats: { label: string; value: string }[]; subtitle?: string }
  | { kind: 'calendar'; month: string; days: { day: number; events?: number; today?: boolean; muted?: boolean }[]; subtitle?: string }

export interface MarketIndex {
  companies: MarketEntry[]
  teams: MarketEntry[]
  agents: MarketEntry[]
  panels: MarketEntry[]
  /** Non-empty when the remote catalog couldn't be reached. The caller should
   *  surface this to the UI instead of silently returning an empty list. */
  warnings: string[]
  source: string
}


function readCatalogFile(rel: string): string {
  return fs.readFileSync(path.join(catalogDir(), rel), 'utf8')
}

function coerceEntry(raw: unknown, type: MarketType): MarketEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : null
  const name = typeof r.name === 'string' ? r.name : id
  if (!id || !name) return null
  return {
    id,
    type,
    name,
    description: typeof r.description === 'string' ? r.description : '',
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    author: typeof r.author === 'string' ? r.author : undefined,
    agent_count:
      typeof r.agent_count === 'number' ? r.agent_count : undefined,
    teams: Array.isArray(r.teams) ? (r.teams as string[]) : undefined,
    category: typeof r.category === 'string' ? r.category : undefined,
    sizes: coerceSizes(r.sizes),
    setup_sql:
      typeof r.setup_sql === 'string' && r.setup_sql.trim()
        ? r.setup_sql
        : undefined,
    preview: coercePreview(r.preview),
  }
}

function coercePreview(raw: unknown): PanelPreview | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const subtitle = typeof r.subtitle === 'string' ? r.subtitle : undefined
  switch (r.kind) {
    case 'line': {
      if (!Array.isArray(r.data)) return undefined
      const data = (r.data as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
      if (data.length === 0) return undefined
      const time_ranges = Array.isArray(r.time_ranges)
        ? (r.time_ranges as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        : undefined
      const default_range =
        typeof r.default_range === 'number' && Number.isFinite(r.default_range)
          ? r.default_range
          : undefined
      return {
        kind: 'line',
        data,
        subtitle,
        time_ranges: time_ranges && time_ranges.length > 0 ? time_ranges : undefined,
        default_range,
      }
    }
    case 'area': {
      if (!Array.isArray(r.data)) return undefined
      const data = (r.data as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
      return data.length > 0 ? { kind: 'area', data, subtitle } : undefined
    }
    case 'bar': {
      if (!Array.isArray(r.bars)) return undefined
      const bars: { label: string; value: number }[] = []
      for (const b of r.bars as unknown[]) {
        if (!b || typeof b !== 'object') continue
        const o = b as Record<string, unknown>
        const label = typeof o.label === 'string' ? o.label : null
        const value = Number(o.value)
        if (label !== null && Number.isFinite(value)) bars.push({ label, value })
      }
      const format = r.format === 'currency' ? 'currency' : undefined
      const orientation =
        r.orientation === 'horizontal' ? 'horizontal' : r.orientation === 'vertical' ? 'vertical' : undefined
      return bars.length > 0 ? { kind: 'bar', bars, subtitle, format, orientation } : undefined
    }
    case 'pie': {
      if (!Array.isArray(r.slices)) return undefined
      const slices: { label: string; value: number }[] = []
      for (const s of r.slices as unknown[]) {
        if (!s || typeof s !== 'object') continue
        const o = s as Record<string, unknown>
        const label = typeof o.label === 'string' ? o.label : null
        const value = Number(o.value)
        if (label !== null && Number.isFinite(value)) slices.push({ label, value })
      }
      return slices.length > 0 ? { kind: 'pie', slices, subtitle } : undefined
    }
    case 'kpi': {
      const value = typeof r.value === 'string' ? r.value : null
      const hint = typeof r.hint === 'string' ? r.hint : ''
      if (!value) return undefined
      const tone = r.tone === 'positive' || r.tone === 'negative' ? r.tone : undefined
      const delta = typeof r.delta === 'string' ? r.delta : undefined
      const target = typeof r.target === 'string' ? r.target : undefined
      const progress =
        typeof r.progress === 'number' && Number.isFinite(r.progress)
          ? Math.max(0, Math.min(100, r.progress))
          : undefined
      return { kind: 'kpi', value, hint, tone, subtitle, delta, target, progress }
    }
    case 'kanban': {
      if (!Array.isArray(r.columns)) return undefined
      const columns: { label: string; cards: string[] }[] = []
      for (const c of r.columns as unknown[]) {
        if (!c || typeof c !== 'object') continue
        const o = c as Record<string, unknown>
        const label = typeof o.label === 'string' ? o.label : null
        const cards = Array.isArray(o.cards)
          ? (o.cards as unknown[]).filter((x): x is string => typeof x === 'string')
          : []
        if (label !== null) columns.push({ label, cards })
      }
      return columns.length > 0 ? { kind: 'kanban', columns, subtitle } : undefined
    }
    case 'table': {
      const columns = Array.isArray(r.columns)
        ? (r.columns as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
      const rows: string[][] = []
      if (Array.isArray(r.rows)) {
        for (const row of r.rows as unknown[]) {
          if (!Array.isArray(row)) continue
          rows.push((row as unknown[]).map((c) => (typeof c === 'string' ? c : String(c ?? ''))))
        }
      }
      return columns.length > 0 ? { kind: 'table', columns, rows, subtitle } : undefined
    }
    case 'calendar': {
      const month = typeof r.month === 'string' ? r.month : ''
      const daysRaw = Array.isArray(r.days) ? r.days : []
      const days: { day: number; events?: number; today?: boolean; muted?: boolean }[] = []
      for (const d of daysRaw) {
        if (!d || typeof d !== 'object') continue
        const o = d as Record<string, unknown>
        const day = Number(o.day)
        if (!Number.isFinite(day)) continue
        days.push({
          day,
          events: typeof o.events === 'number' ? o.events : undefined,
          today: o.today === true ? true : undefined,
          muted: o.muted === true ? true : undefined,
        })
      }
      if (!month || days.length === 0) return undefined
      return { kind: 'calendar', month, days, subtitle }
    }
    case 'stat_row': {
      if (!Array.isArray(r.stats)) return undefined
      const stats: { label: string; value: string }[] = []
      for (const s of r.stats as unknown[]) {
        if (!s || typeof s !== 'object') continue
        const o = s as Record<string, unknown>
        const label = typeof o.label === 'string' ? o.label : null
        const value =
          typeof o.value === 'string' ? o.value : typeof o.value === 'number' ? String(o.value) : null
        if (label && value !== null) stats.push({ label, value })
      }
      return stats.length > 0 ? { kind: 'stat_row', stats, subtitle } : undefined
    }
    case 'heatmap': {
      const rowLabels = Array.isArray(r.rowLabels)
        ? (r.rowLabels as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
      const colLabels = Array.isArray(r.colLabels)
        ? (r.colLabels as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
      const values: number[][] = []
      if (Array.isArray(r.values)) {
        for (const row of r.values as unknown[]) {
          if (!Array.isArray(row)) continue
          values.push((row as unknown[]).map((v) => Number(v)).map((v) => (Number.isFinite(v) ? v : 0)))
        }
      }
      if (rowLabels.length === 0 || colLabels.length === 0 || values.length === 0) {
        return undefined
      }
      return { kind: 'heatmap', rowLabels, colLabels, values, subtitle }
    }
    default:
      return undefined
  }
}

function coerceSizes(raw: unknown): PanelSize[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PanelSize[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const c = Number(o.colSpan ?? o.c)
    const r = Number(o.rowSpan ?? o.r)
    if (![1, 2, 3, 4].includes(c) || ![1, 2, 3, 4].includes(r)) continue
    out.push({ colSpan: c as 1 | 2 | 3 | 4, rowSpan: r as 1 | 2 | 3 | 4 })
  }
  return out.length > 0 ? out : undefined
}

/** Read and parse the local catalog manifest. Returns an empty shape with
 *  a `warnings[]` entry if the on-disk catalog is missing or malformed —
 *  callers should not throw the whole UI away. */
export async function fetchMarketIndex(): Promise<MarketIndex> {
  const dir = catalogDir()
  try {
    const text = readCatalogFile('index.json')
    const raw = JSON.parse(text) as Record<string, unknown>
    const companies = Array.isArray(raw.companies)
      ? (raw.companies as unknown[])
          .map((x) => coerceEntry(x, 'company'))
          .filter((x): x is MarketEntry => !!x)
      : []
    const teams = Array.isArray(raw.teams)
      ? (raw.teams as unknown[])
          .map((x) => coerceEntry(x, 'team'))
          .filter((x): x is MarketEntry => !!x)
      : []
    const agents = Array.isArray(raw.agents)
      ? (raw.agents as unknown[])
          .map((x) => coerceEntry(x, 'agent'))
          .filter((x): x is MarketEntry => !!x)
      : []
    const panels = Array.isArray(raw.panels)
      ? (raw.panels as unknown[])
          .map((x) => coerceEntry(x, 'panel'))
          .filter((x): x is MarketEntry => !!x)
      : []
    return { companies, teams, agents, panels, warnings: [], source: dir }
  } catch (e) {
    return {
      companies: [],
      teams: [],
      agents: [],
      panels: [],
      warnings: [
        `Failed to load local catalog at ${dir} (${e instanceof Error ? e.message : String(e)}).`,
      ],
      source: dir,
    }
  }
}

function pathFor(type: MarketType, id: string, category?: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_')
  switch (type) {
    case 'team':
      return `teams/${safe}.openhive-frame.yaml`
    case 'agent':
      return `agents/${safe}.openhive-agent-frame.yaml`
    case 'company':
      return `companies/${safe}.openhive-company.yaml`
    case 'panel': {
      // Panels live under panels/<category>/<id>.yaml. Category is required —
      // caller must supply it from the index entry.
      const cat = (category ?? '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'uncategorized'
      return `panels/${cat}/${safe}.openhive-panel-frame.yaml`
    }
  }
}

/** Read and parse a single frame YAML from the local catalog. Returns the
 *  parsed object — exactly what `installFrame` / `installAgentFrame`
 *  expects as `frame`. */
export async function fetchMarketFrame(
  type: MarketType,
  id: string,
  category?: string,
): Promise<unknown> {
  const text = readCatalogFile(pathFor(type, id, category))
  return yaml.load(text)
}
