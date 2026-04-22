/**
 * Usage logging — FS-only. Every call appends to the owning session's
 * ~/.openhive/sessions/{id}/usage.json list. Aggregation queries scan all
 * session usage.json files.
 *
 * For sessions still in flight we accept null sessionId (rare — engine
 * always knows its session) and drop the record silently since nothing
 * would be able to look it up later.
 */

import fs from 'node:fs'

import { listSessions, sessionDir, sessionUsagePath } from './sessions'

export type UsagePeriod = '24h' | '7d' | '30d' | 'all'

// Rough $ / 1M tokens (input, output).
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

export type ThresholdTrigger = 'none' | 'warning' | 'autocompact' | 'blocking'

export interface RecordUsageInput {
  sessionId: string | null
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
  systemChars?: number
  toolsChars?: number
  historyChars?: number
  /** A4: our pre-turn estimate of input tokens (system + tools + history). */
  estimatedInputTokens?: number
  /** A4: authoritative value reported by the provider. Same as inputTokens,
   *  kept separate for drift analysis. */
  actualInputTokens?: number
  /** A4: effectiveWindow snapshot at call time. */
  effectiveWindow?: number
  autoCompactThreshold?: number
  warningThreshold?: number
  blockingLimit?: number
  /** A4: which threshold, if any, the estimate crossed. */
  thresholdTriggered?: ThresholdTrigger
}

interface UsageRow {
  ts: number
  session_id: string
  company_id: string | null
  team_id: string | null
  agent_id: string | null
  agent_role: string | null
  provider_id: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd_cents: number
  system_chars: number
  tools_chars: number
  history_chars: number
  // A4 — all default 0 / 'none' so existing-row normalisation is trivial.
  estimated_input_tokens: number
  actual_input_tokens: number
  effective_window: number
  autocompact_threshold: number
  warning_threshold: number
  blocking_limit: number
  threshold_triggered: ThresholdTrigger
}

function readRows(sessionId: string): UsageRow[] {
  const p = sessionUsagePath(sessionId)
  if (!fs.existsSync(p)) return []
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(data) ? (data as UsageRow[]) : []
  } catch {
    return []
  }
}

function writeRows(sessionId: string, rows: UsageRow[]): void {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true })
  const p = sessionUsagePath(sessionId)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

export function recordUsage(input: RecordUsageInput): void {
  if (!input.sessionId) return
  const cost = estimateCostCents(input.model, input.inputTokens, input.outputTokens)
  const row: UsageRow = {
    ts: Date.now(),
    session_id: input.sessionId,
    company_id: input.companyId,
    team_id: input.teamId,
    agent_id: input.agentId,
    agent_role: input.agentRole,
    provider_id: input.providerId,
    model: input.model,
    input_tokens: Math.trunc(input.inputTokens),
    output_tokens: Math.trunc(input.outputTokens),
    cache_read_tokens: Math.trunc(input.cacheReadTokens ?? 0),
    cache_write_tokens: Math.trunc(input.cacheWriteTokens ?? 0),
    cost_usd_cents: cost,
    system_chars: Math.trunc(input.systemChars ?? 0),
    tools_chars: Math.trunc(input.toolsChars ?? 0),
    history_chars: Math.trunc(input.historyChars ?? 0),
    estimated_input_tokens: Math.trunc(input.estimatedInputTokens ?? 0),
    actual_input_tokens: Math.trunc(input.actualInputTokens ?? 0),
    effective_window: Math.trunc(input.effectiveWindow ?? 0),
    autocompact_threshold: Math.trunc(input.autoCompactThreshold ?? 0),
    warning_threshold: Math.trunc(input.warningThreshold ?? 0),
    blocking_limit: Math.trunc(input.blockingLimit ?? 0),
    threshold_triggered: input.thresholdTriggered ?? 'none',
  }
  const existing = readRows(input.sessionId)
  existing.push(row)
  writeRows(input.sessionId, existing)
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

function allRowsSince(since: number): UsageRow[] {
  const out: UsageRow[] = []
  for (const meta of listSessions(10_000)) {
    for (const row of readRows(meta.id)) {
      if (row.ts >= since) out.push(row)
    }
  }
  return out
}

function groupRows(rows: UsageRow[], keyFn: (r: UsageRow) => string | null): UsageGroupRow[] {
  const buckets = new Map<string, UsageGroupRow>()
  for (const r of rows) {
    const rawKey = keyFn(r)
    const key = rawKey ?? '-'
    const b = buckets.get(key) ?? {
      key,
      input_tokens: 0,
      output_tokens: 0,
      cache_read: 0,
      cache_write: 0,
      cost_cents: 0,
      n: 0,
    }
    b.input_tokens += r.input_tokens
    b.output_tokens += r.output_tokens
    b.cache_read += r.cache_read_tokens
    b.cache_write += r.cache_write_tokens
    b.cost_cents += r.cost_usd_cents
    b.n += 1
    buckets.set(key, b)
  }
  return Array.from(buckets.values()).sort(
    (a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens),
  )
}

export interface SessionUsage {
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  cost_cents: number
  n: number
}

export function usageForSession(sessionId: string): SessionUsage {
  const agg: SessionUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cost_cents: 0,
    n: 0,
  }
  for (const r of readRows(sessionId)) {
    agg.input_tokens += r.input_tokens
    agg.output_tokens += r.output_tokens
    agg.cache_read += r.cache_read_tokens
    agg.cache_write += r.cache_write_tokens
    agg.cost_cents += r.cost_usd_cents
    agg.n += 1
  }
  return agg
}

export function usageForSessions(sessionIds: string[]): Record<string, SessionUsage> {
  const out: Record<string, SessionUsage> = {}
  for (const id of sessionIds) out[id] = usageForSession(id)
  return out
}

export function summary(period: UsagePeriod = 'all'): UsageSummary {
  const rows = allRowsSince(sinceMs(period))
  const totals = rows.reduce<UsageTotals>(
    (acc, r) => {
      acc.input_tokens += r.input_tokens
      acc.output_tokens += r.output_tokens
      acc.cache_read += r.cache_read_tokens
      acc.cache_write += r.cache_write_tokens
      acc.cost_cents += r.cost_usd_cents
      acc.n += 1
      return acc
    },
    { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_cents: 0, n: 0 },
  )
  return {
    period,
    totals,
    by_company: groupRows(rows, (r) => r.company_id),
    by_team: groupRows(rows, (r) => r.team_id),
    by_agent: groupRows(rows, (r) => r.agent_id),
    by_provider: groupRows(rows, (r) => r.provider_id),
    by_model: groupRows(rows, (r) => r.model),
  }
}
