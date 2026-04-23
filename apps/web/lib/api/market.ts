/** Client bindings for the Frame Market (cloud catalog of shareable
 *  company / team / agent frames). Server fetches from GitHub; the UI just
 *  talks to our /api/market endpoints. */

export type MarketType = 'company' | 'team' | 'agent'

export interface MarketEntry {
  id: string
  type: MarketType
  name: string
  description: string
  version: string
  tags: string[]
  author?: string
  agent_count?: number
  teams?: string[]
}

export interface MarketIndex {
  companies: MarketEntry[]
  teams: MarketEntry[]
  agents: MarketEntry[]
  warnings: string[]
  source: string
}

export async function fetchMarketIndex(): Promise<MarketIndex> {
  const res = await fetch('/api/market')
  if (!res.ok) throw new Error(`GET /api/market ${res.status}`)
  return (await res.json()) as MarketIndex
}

export interface InstallMarketResult {
  type: MarketType
  id: string
  team?: Record<string, unknown>
  agent?: Record<string, unknown>
  warnings?: string[]
}

export async function installMarketEntry(input: {
  type: MarketType
  id: string
  target_company_slug?: string
  target_team_slug?: string
}): Promise<InstallMarketResult> {
  const res = await fetch('/api/market/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`install failed (${res.status}): ${body}`)
  }
  return (await res.json()) as InstallMarketResult
}
