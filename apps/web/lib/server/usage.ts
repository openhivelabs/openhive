/**
 * Usage logging + aggregation. Ports apps/server/openhive/persistence/usage.py.
 *
 * Reads and writes the same `usage_logs` table as the Python side. During
 * migration only the read path is exercised from TS (the engine is still in
 * Python and writes its own rows); once Phase 4 lands, writes move here too.
 */

import { getDb } from './db'

export type UsagePeriod = '24h' | '7d' | '30d' | 'all'

// Rough $ / 1M tokens (input, output). Kept in sync with the Python table.
const RATES: Record<string, [number, number]> = {
  'claude-opus-4': [15.0, 75.0],
  'claude-sonnet-4': [3.0, 15.0],
  'claude-haiku-4': [0.8, 4.0],
  'gpt-5': [5.0, 15.0],
  'gpt-5-mini': [0.6, 2.4],
  'gpt-4o': [2.5, 10.0],
  'gpt-4o-mini': [0.15, 0.6],
  o3: [2.0, 8.0],
  'o3-mini': [1.1, 4.4],
}

function rateFor(model: string): [number, number] {
  for (const [key, rate] of Object.entries(RATES)) {
    if (model.startsWith(key)) return rate
  }
  return [0, 0]
}

export function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const [rin, rout] = rateFor(model)
  return (rin * inputTokens + rout * outputTokens) / 10_000
}

export interface RecordUsageInput {
  runId: string | null
  companyId: string | null
  teamId: string | null
  agentId: string | null
  agentRole: string | null
  providerId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  // Phase G1 — char counts of the prompt payload regions we built.
  // Not tokens; a cheap attribution proxy. char/token ratio is model-stable
  // enough (≈3–4 for latin, ≈1–2 for CJK) to rank spend by region.
  systemChars?: number
  toolsChars?: number
  historyChars?: number
}

export function recordUsage(input: RecordUsageInput): void {
  const cost = estimateCostCents(input.model, input.inputTokens, input.outputTokens)
  getDb()
    .prepare(
      `INSERT INTO usage_logs
        (ts, run_id, company_id, team_id, agent_id, agent_role,
         provider_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd_cents,
         system_chars, tools_chars, history_chars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now(),
      input.runId,
      input.companyId,
      input.teamId,
      input.agentId,
      input.agentRole,
      input.providerId,
      input.model,
      Math.trunc(input.inputTokens),
      Math.trunc(input.outputTokens),
      Math.trunc(input.cacheReadTokens ?? 0),
      Math.trunc(input.cacheWriteTokens ?? 0),
      cost,
      Math.trunc(input.systemChars ?? 0),
      Math.trunc(input.toolsChars ?? 0),
      Math.trunc(input.historyChars ?? 0),
    )
}

function sinceMs(period: UsagePeriod): number {
  const now = Date.now()
  if (period === '24h') return now - 24 * 3600 * 1000
  if (period === '7d') return now - 7 * 24 * 3600 * 1000
  if (period === '30d') return now - 30 * 24 * 3600 * 1000
  return 0
}

export interface UsageGroupRow {
  key: string
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  cost_cents: number
  n: number
}

export interface UsageTotals {
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  cost_cents: number
  n: number
}

export interface UsageSummary {
  period: UsagePeriod
  totals: UsageTotals
  by_company: UsageGroupRow[]
  by_team: UsageGroupRow[]
  by_agent: UsageGroupRow[]
  by_provider: UsageGroupRow[]
  by_model: UsageGroupRow[]
}

function group(by: string, since: number): UsageGroupRow[] {
  // `by` is a hardcoded column name — never user input, so string interpolation
  // is safe here (parameterised SQL doesn't support column-name binding).
  return getDb()
    .prepare(
      `SELECT COALESCE(${by}, '-') AS key,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read,
              SUM(cache_write_tokens) AS cache_write,
              SUM(cost_usd_cents) AS cost_cents,
              COUNT(*) AS n
       FROM usage_logs
       WHERE ts >= ?
       GROUP BY COALESCE(${by}, '-')
       ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`,
    )
    .all(since) as UsageGroupRow[]
}

export function summary(period: UsagePeriod = 'all'): UsageSummary {
  const since = sinceMs(period)
  const totals = getDb()
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
              COALESCE(SUM(cost_usd_cents), 0) AS cost_cents,
              COUNT(*) AS n
       FROM usage_logs
       WHERE ts >= ?`,
    )
    .get(since) as UsageTotals
  return {
    period,
    totals,
    by_company: group('company_id', since),
    by_team: group('team_id', since),
    by_agent: group('agent_id', since),
    by_provider: group('provider_id', since),
    by_model: group('model', since),
  }
}
