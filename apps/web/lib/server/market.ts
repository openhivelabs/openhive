/**
 * Frame Market — remote catalog of shareable company / team / agent frames.
 *
 * Source of truth lives in a GitHub repo whose base URL is configurable via
 * `OPENHIVE_MARKET_BASE_URL`. Default points at the canonical openhive market
 * repo. The server fetches an `index.json` manifest and individual frame
 * YAMLs on demand, never caching on disk — clients always see the latest
 * catalog push.
 *
 * Repo layout (relative to base):
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
import { repoRoot } from './paths'

const DEFAULT_BASE_URL =
  'https://raw.githubusercontent.com/openhivelabs/frame-market/main'

function baseUrl(): string {
  return (process.env.OPENHIVE_MARKET_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  )
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
}

export interface PanelSize {
  colSpan: 1 | 2 | 3 | 4
  rowSpan: 1 | 2 | 3 | 4
}

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

/** Built-in demo catalog. Shown automatically when the remote catalog is
 *  unreachable or empty, so the market UI never looks dead during dev / before
 *  a real frame-market repo is published. Entries are prefixed `demo-` and
 *  are NOT installable (install endpoint returns a friendly error). */
const DEMO_COMPANIES: MarketEntry[] = [
  {
    id: 'demo-acme',
    type: 'company',
    name: 'Acme Holdings',
    description:
      'Consumer goods conglomerate with sales, support, and ops teams pre-wired.',
    tags: ['demo', 'bundle', 'sales'],
    author: 'Openhive Demo',
    teams: ['demo-sales-crm', 'demo-support-desk', 'demo-ops'],
  },
  {
    id: 'demo-globex',
    type: 'company',
    name: 'Globex Research',
    description:
      'R&D org template — literature review agents, experiment tracker, and weekly digest.',
    tags: ['demo', 'bundle', 'research'],
    author: 'Openhive Demo',
    teams: ['demo-research', 'demo-lab-ops'],
  },
  {
    id: 'demo-initech',
    type: 'company',
    name: 'Initech Consulting',
    description:
      'Services firm layout — billable hours, client CRM, and project tracker.',
    tags: ['demo', 'bundle', 'services'],
    author: 'Openhive Demo',
    teams: ['demo-clients', 'demo-billing'],
  },
]

const DEMO_TEAMS: MarketEntry[] = [
  {
    id: 'demo-sales-crm',
    type: 'team',
    name: 'Sales CRM',
    description:
      'Deal pipeline, activity log, and a deal-qualification agent. Starter dashboard included.',
    tags: ['demo', 'sales', 'pipeline'],
    author: 'Openhive Demo',
    agent_count: 2,
  },
  {
    id: 'demo-support-desk',
    type: 'team',
    name: 'Customer Support',
    description:
      'Ticket triage team with auto-categorization and first-response drafting.',
    tags: ['demo', 'support', 'tickets'],
    author: 'Openhive Demo',
    agent_count: 3,
  },
  {
    id: 'demo-research',
    type: 'team',
    name: 'Research Cell',
    description:
      'Literature review + summarization workflow. Pulls PDFs, hands off to a critic.',
    tags: ['demo', 'research', 'rag'],
    author: 'Openhive Demo',
    agent_count: 4,
  },
  {
    id: 'demo-ops',
    type: 'team',
    name: 'Ops Runbook',
    description:
      'On-call rotation, incident log, and a runbook-followup agent.',
    tags: ['demo', 'ops', 'oncall'],
    author: 'Openhive Demo',
    agent_count: 2,
  },
]

const DEMO_AGENTS: MarketEntry[] = [
  {
    id: 'demo-researcher',
    type: 'agent',
    name: 'Researcher',
    description: 'Gathers sources, cites, and returns a structured brief.',
    tags: ['demo', 'research', 'writing'],
    author: 'Openhive Demo',
  },
  {
    id: 'demo-reviewer',
    type: 'agent',
    name: 'Critic Reviewer',
    description:
      'Audits another agent\'s output against a rubric; flags gaps inline.',
    tags: ['demo', 'review', 'qa'],
    author: 'Openhive Demo',
  },
  {
    id: 'demo-triager',
    type: 'agent',
    name: 'Ticket Triager',
    description:
      'Classifies incoming tickets, assigns priority, suggests first reply.',
    tags: ['demo', 'support'],
    author: 'Openhive Demo',
  },
  {
    id: 'demo-writer',
    type: 'agent',
    name: 'Release Notes Writer',
    description:
      'Turns a PR list into customer-facing release notes in a given tone.',
    tags: ['demo', 'writing', 'devrel'],
    author: 'Openhive Demo',
  },
  {
    id: 'demo-scheduler',
    type: 'agent',
    name: 'Calendar Scheduler',
    description:
      'Finds overlap across attendee calendars and drafts an invite.',
    tags: ['demo', 'calendar', 'ops'],
    author: 'Openhive Demo',
  },
]

/** Shared `customer` DDL used by the 6 original seed panels. Kept as a
 *  single string constant so all six entries stay in lock-step. */
const CUSTOMER_SETUP_SQL = `CREATE TABLE IF NOT EXISTS customer (
  team_id    TEXT NOT NULL,
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT,
  email      TEXT,
  stage      TEXT DEFAULT 'prospect',
  value      REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
)`

const DEAL_SETUP_SQL = `CREATE TABLE IF NOT EXISTS deal (
  team_id     TEXT NOT NULL,
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  amount      REAL DEFAULT 0,
  stage       TEXT DEFAULT 'prospect',
  customer_id INTEGER,
  created_at  TEXT DEFAULT (datetime('now'))
)`

const TASK_SETUP_SQL = `CREATE TABLE IF NOT EXISTS task (
  team_id     TEXT NOT NULL,
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  status      TEXT DEFAULT 'todo',
  customer_id INTEGER,
  deal_id     INTEGER,
  due_at      TEXT
)`

const WORKOUT_SETUP_SQL = `CREATE TABLE IF NOT EXISTS workout (
  team_id      TEXT NOT NULL,
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  duration_min INTEGER DEFAULT 0,
  intensity    TEXT DEFAULT 'medium',
  notes        TEXT,
  logged_at    TEXT DEFAULT (datetime('now'))
)`

const BOOK_SETUP_SQL = `CREATE TABLE IF NOT EXISTS book (
  team_id  TEXT NOT NULL,
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  title    TEXT NOT NULL,
  author   TEXT,
  status   TEXT DEFAULT 'unread',
  rating   INTEGER,
  added_at TEXT DEFAULT (datetime('now'))
)`

const PLAYER_SETUP_SQL = `CREATE TABLE IF NOT EXISTS player (
  team_id  TEXT NOT NULL,
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  position TEXT,
  jersey   INTEGER,
  bats     TEXT,
  throws   TEXT,
  added_at TEXT DEFAULT (datetime('now'))
)`

const EPISODE_SETUP_SQL = `CREATE TABLE IF NOT EXISTS episode (
  team_id      TEXT NOT NULL,
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       INTEGER,
  title        TEXT NOT NULL,
  guest_name   TEXT,
  duration_min INTEGER,
  status       TEXT DEFAULT 'draft',
  release_at   TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
)`

/** Curated seed catalog — 2 categories × 3 panels each (plus 2 extra
 *  relational panels used by the install-plan Playwright tests). These
 *  mirror the YAML frames in `frame-market-seed/`; publish that folder
 *  to the remote `frame-market` repo to make them installable. */
const DEMO_PANELS: MarketEntry[] = [
  // ── kpi ──
  {
    id: 'demo-total-count',
    type: 'panel',
    name: 'Total Count',
    description:
      'Single-number tile: total rows in a chosen table. Default reads the customer table.',
    tags: ['count', 'universal'],
    author: 'OpenHive',
    category: 'kpi',
    sizes: [
      { colSpan: 1, rowSpan: 1 },
      { colSpan: 2, rowSpan: 1 },
    ],
    setup_sql: CUSTOMER_SETUP_SQL,
  },
  {
    id: 'demo-sum-metric',
    type: 'panel',
    name: 'Sum Metric',
    description:
      'Sum of a numeric column across all rows. Default sums the `value` column on the customer table.',
    tags: ['sum', 'universal'],
    author: 'OpenHive',
    category: 'kpi',
    sizes: [
      { colSpan: 1, rowSpan: 1 },
      { colSpan: 2, rowSpan: 1 },
    ],
    setup_sql: CUSTOMER_SETUP_SQL,
  },
  {
    id: 'demo-period-change',
    type: 'panel',
    name: 'Period Change %',
    description:
      'Week-over-week percent change in row count. Assumes a `created_at` column (ISO date or unix epoch).',
    tags: ['growth', 'universal'],
    author: 'OpenHive',
    category: 'kpi',
    sizes: [
      { colSpan: 1, rowSpan: 1 },
      { colSpan: 2, rowSpan: 1 },
    ],
    setup_sql: CUSTOMER_SETUP_SQL,
  },

  // ── chart ──
  {
    id: 'demo-trend-line',
    type: 'panel',
    name: 'Trend Line',
    description:
      'Line chart of daily row count over the last 30 days. Swap the table to trend any time-series.',
    tags: ['trend', 'time-series', 'universal'],
    author: 'OpenHive',
    category: 'chart',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: CUSTOMER_SETUP_SQL,
  },
  {
    id: 'demo-bar-by-category',
    type: 'panel',
    name: 'Bar by Category',
    description:
      'Horizontal bar chart grouped by a category column. Default groups the customer table by `stage`.',
    tags: ['bar', 'distribution', 'universal'],
    author: 'OpenHive',
    category: 'chart',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 3, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: CUSTOMER_SETUP_SQL,
  },
  {
    id: 'demo-stacked-composition',
    type: 'panel',
    name: 'Stacked Composition',
    description:
      'Composition of a total broken down by a grouping column — useful for pipeline mix, channel breakdowns.',
    tags: ['composition', 'mix', 'universal'],
    author: 'OpenHive',
    category: 'chart',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: CUSTOMER_SETUP_SQL,
  },

  // ── relational panels for install-plan testing ──
  {
    id: 'demo-deal-pipeline',
    type: 'panel',
    name: 'Deal Pipeline',
    description:
      'Table of open deals with amount, stage, owner. Deal carries customer_id so it links to any customer table the user already has.',
    tags: ['sales', 'relational'],
    author: 'OpenHive',
    category: 'table',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: DEAL_SETUP_SQL,
  },
  {
    id: 'demo-task-board',
    type: 'panel',
    name: 'Task Board',
    description:
      'Kanban of tasks grouped by status. Task carries customer_id and deal_id for cross-entity linking.',
    tags: ['ops', 'relational'],
    author: 'OpenHive',
    category: 'kanban',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: TASK_SETUP_SQL,
  },

  // ── cross-domain panels (install-plan stress tests) ──
  {
    id: 'demo-workout-log',
    type: 'panel',
    name: 'Workout Log',
    description:
      'Fitness log — record workouts with duration and intensity. Own `workout` table, unrelated to business data.',
    tags: ['fitness', 'personal'],
    author: 'OpenHive',
    category: 'table',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: WORKOUT_SETUP_SQL,
  },
  {
    id: 'demo-library-books',
    type: 'panel',
    name: 'Library Books',
    description:
      'Personal library — books with title, author, status. `book` table.',
    tags: ['library', 'personal'],
    author: 'OpenHive',
    category: 'table',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: BOOK_SETUP_SQL,
  },
  {
    id: 'demo-baseball-roster',
    type: 'panel',
    name: 'Baseball Roster',
    description:
      'Team roster — players with position and jersey number. `player` table, sport-specific.',
    tags: ['baseball', 'sports'],
    author: 'OpenHive',
    category: 'table',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: PLAYER_SETUP_SQL,
  },
  {
    id: 'demo-podcast-episodes',
    type: 'panel',
    name: 'Podcast Episodes',
    description:
      'Podcast studio — episodes with guest, duration, release status. `episode` table.',
    tags: ['podcast', 'media'],
    author: 'OpenHive',
    category: 'table',
    sizes: [
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 2 },
    ],
    setup_sql: EPISODE_SETUP_SQL,
  },
]

const DEMO_INDEX: MarketIndex = {
  companies: DEMO_COMPANIES,
  teams: DEMO_TEAMS,
  agents: DEMO_AGENTS,
  panels: DEMO_PANELS,
  warnings: [],
  source: 'demo:builtin',
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'openhive-market-client' },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return res.text()
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

/** Fetch and parse the market manifest. Returns an index shape with empty
 *  arrays + a `warnings[]` entry when the remote is unreachable — callers
 *  should not throw the whole UI away just because the market is down. */
export async function fetchMarketIndex(): Promise<MarketIndex> {
  const base = baseUrl()
  const url = `${base}/index.json`
  try {
    const text = await getText(url)
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
    const allEmpty =
      companies.length === 0 &&
      teams.length === 0 &&
      agents.length === 0 &&
      panels.length === 0
    if (allEmpty) {
      return { ...DEMO_INDEX, source: `${base} (demo fallback)` }
    }
    return { companies, teams, agents, panels, warnings: [], source: base }
  } catch (e) {
    // Remote unreachable — serve built-in demo catalog so the market UI still
    // has something to show. The warning banner tells users this is a fallback.
    return {
      ...DEMO_INDEX,
      warnings: [
        `Market catalog unreachable (${e instanceof Error ? e.message : String(e)}) — showing built-in demo entries.`,
      ],
      source: `${base} (demo fallback)`,
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
      // Panels live under panels/<category>/<id>.yaml in the remote repo.
      // Category is required — caller must supply it from the index entry.
      const cat = (category ?? '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'uncategorized'
      return `panels/${cat}/${safe}.openhive-panel-frame.yaml`
    }
  }
}

/** Download and parse a single frame YAML from the remote market. Returns
 *  the parsed object — exactly what `installFrame` / `installAgentFrame`
 *  expects as `frame`.
 *
 *  Demo panel entries (`demo-*` id + `type=panel`) are resolved to the
 *  local `frame-market-seed/panels/<category>/<id-without-demo->.yaml`
 *  file so the market is end-to-end installable during dev + tests
 *  without any external repo. Non-panel demos still throw. */
export async function fetchMarketFrame(
  type: MarketType,
  id: string,
  category?: string,
): Promise<unknown> {
  if (id.startsWith('demo-')) {
    if (type === 'panel') {
      const local = loadLocalSeedPanel(id.replace(/^demo-/, ''), category ?? '')
      if (local) return local
    }
    const err = new Error(
      'This is a demo entry from the built-in catalog — publish a real frame to the market repo to install it.',
    )
    ;(err as { code?: string }).code = 'DEMO'
    throw err
  }
  const base = baseUrl()
  const url = `${base}/${pathFor(type, id, category)}`
  const text = await getText(url)
  return yaml.load(text)
}

/** Load a panel frame from `frame-market-seed/` in the repo. Returns null
 *  if the file doesn't exist (caller falls back to the DEMO error). */
function loadLocalSeedPanel(id: string, category: string): unknown | null {
  try {
    const seedRoot = process.env.OPENHIVE_MARKET_SEED_DIR
      ? process.env.OPENHIVE_MARKET_SEED_DIR
      : path.join(repoRoot(), 'frame-market-seed')
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '_')
    const safeCat = category.replace(/[^a-zA-Z0-9._-]/g, '_')
    const file = path.join(
      seedRoot,
      'panels',
      safeCat,
      `${safeId}.openhive-panel-frame.yaml`,
    )
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null
    return yaml.load(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
