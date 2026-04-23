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
 *   index.json                       { companies, teams, agents }
 *   teams/<id>.openhive-frame.yaml
 *   agents/<id>.openhive-agent-frame.yaml
 *   companies/<id>.openhive-company.yaml   (bundles team frame ids)
 */
import yaml from 'js-yaml'

const DEFAULT_BASE_URL =
  'https://raw.githubusercontent.com/openhivelabs/frame-market/main'

function baseUrl(): string {
  return (process.env.OPENHIVE_MARKET_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  )
}

export type MarketType = 'company' | 'team' | 'agent'

export interface MarketEntry {
  id: string
  type: MarketType
  name: string
  description: string
  version: string
  tags: string[]
  author?: string
  /** type=team → agent_count from team frame (best-effort). */
  agent_count?: number
  /** type=company → bundled team frame ids. */
  teams?: string[]
}

export interface MarketIndex {
  companies: MarketEntry[]
  teams: MarketEntry[]
  agents: MarketEntry[]
  /** Non-empty when the remote catalog couldn't be reached. The caller should
   *  surface this to the UI instead of silently returning an empty list. */
  warnings: string[]
  source: string
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
    version: typeof r.version === 'string' ? r.version : '1.0.0',
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    author: typeof r.author === 'string' ? r.author : undefined,
    agent_count:
      typeof r.agent_count === 'number' ? r.agent_count : undefined,
    teams: Array.isArray(r.teams) ? (r.teams as string[]) : undefined,
  }
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
    return { companies, teams, agents, warnings: [], source: base }
  } catch (e) {
    return {
      companies: [],
      teams: [],
      agents: [],
      warnings: [
        `Market catalog unreachable: ${e instanceof Error ? e.message : String(e)}`,
      ],
      source: base,
    }
  }
}

function pathFor(type: MarketType, id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_')
  switch (type) {
    case 'team':
      return `teams/${safe}.openhive-frame.yaml`
    case 'agent':
      return `agents/${safe}.openhive-agent-frame.yaml`
    case 'company':
      return `companies/${safe}.openhive-company.yaml`
  }
}

/** Download and parse a single frame YAML from the remote market. Returns
 *  the parsed object — exactly what `installFrame` / `installAgentFrame`
 *  expects as `frame`. */
export async function fetchMarketFrame(
  type: MarketType,
  id: string,
): Promise<unknown> {
  const base = baseUrl()
  const url = `${base}/${pathFor(type, id)}`
  const text = await getText(url)
  return yaml.load(text)
}
