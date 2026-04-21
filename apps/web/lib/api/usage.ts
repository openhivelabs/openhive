export type UsagePeriod = '24h' | '7d' | '30d' | 'all'

export interface UsageRow {
  key: string
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  cost_cents: number
  n: number
}

export interface UsageSummary {
  period: UsagePeriod
  totals: Omit<UsageRow, 'key'>
  by_company: UsageRow[]
  by_team: UsageRow[]
  by_agent: UsageRow[]
  by_provider: UsageRow[]
  by_model: UsageRow[]
}

export async function fetchUsage(period: UsagePeriod = 'all'): Promise<UsageSummary> {
  const res = await fetch(`/api/usage/summary?period=${period}`)
  if (!res.ok) throw new Error(`usage ${res.status}`)
  return (await res.json()) as UsageSummary
}
