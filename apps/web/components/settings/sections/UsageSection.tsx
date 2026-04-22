import { clsx } from 'clsx'
import { useEffect, useState } from 'react'
import { SectionHeader } from '@/components/settings/SettingsShell'
import { fetchUsage, type UsagePeriod, type UsageRow, type UsageSummary } from '@/lib/api/usage'
import { useAppStore } from '@/lib/stores/useAppStore'

const PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7일' },
  { id: '30d', label: '30일' },
  { id: 'all', label: '전체' },
]

type GroupKey = 'company' | 'team' | 'agent' | 'model' | 'provider'

const GROUPS: { id: GroupKey; label: string }[] = [
  { id: 'company', label: '회사' },
  { id: 'team', label: '팀' },
  { id: 'agent', label: '에이전트' },
  { id: 'model', label: '모델' },
  { id: 'provider', label: '프로바이더' },
]

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function fmtCost(cents: number): string {
  const dollars = cents / 100
  if (dollars < 0.01) return '$0.00'
  if (dollars < 1) return `$${dollars.toFixed(3)}`
  return `$${dollars.toFixed(2)}`
}

export function UsageSection() {
  const companies = useAppStore((s) => s.companies)
  const [period, setPeriod] = useState<UsagePeriod>('all')
  const [group, setGroup] = useState<GroupKey>('team')
  const [data, setData] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchUsage(period)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [period])

  const idToLabel = (() => {
    const map: Record<string, string> = {}
    for (const c of companies) {
      map[c.id] = c.name
      map[c.slug] = c.name
      for (const t of c.teams) {
        map[t.id] = t.name
        map[t.slug] = t.name
        for (const a of t.agents) {
          map[a.id] = `${a.role} · ${t.name}`
        }
      }
    }
    return map
  })()

  const labelFor = (key: string) => (key === '-' ? '—' : (idToLabel[key] ?? key))
  const passthrough = (k: string) => (k === '-' ? '—' : k)

  const groupRows: Record<GroupKey, UsageRow[]> = {
    company: data?.by_company ?? [],
    team: data?.by_team ?? [],
    agent: data?.by_agent ?? [],
    model: data?.by_model ?? [],
    provider: data?.by_provider ?? [],
  }
  const groupLabel: Record<GroupKey, (k: string) => string> = {
    company: labelFor,
    team: labelFor,
    agent: labelFor,
    model: passthrough,
    provider: passthrough,
  }

  const totals = data?.totals

  return (
    <>
      <SectionHeader title="사용량" desc="에이전트가 소비한 토큰과 비용 추정치." />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Segmented
          value={period}
          options={PERIODS}
          onChange={(v) => setPeriod(v as UsagePeriod)}
        />
        <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-1" />
        <Segmented
          value={group}
          options={GROUPS}
          onChange={(v) => setGroup(v as GroupKey)}
        />
      </div>

      {error && (
        <div className="rounded-sm border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-[14px] px-2 py-1.5 mb-3">
          {error}
        </div>
      )}

      <div className="grid grid-cols-4 gap-2 mb-6">
        <Kpi label="입력 토큰" value={fmtTokens(totals?.input_tokens ?? 0)} />
        <Kpi label="출력 토큰" value={fmtTokens(totals?.output_tokens ?? 0)} />
        <Kpi label="요청 수" value={String(totals?.n ?? 0)} />
        <Kpi label="예상 비용" value={fmtCost(totals?.cost_cents ?? 0)} />
      </div>

      <Breakdown
        title={`${GROUPS.find((g) => g.id === group)?.label}별 내역`}
        rows={groupRows[group]}
        label={groupLabel[group]}
        loading={loading && !data}
      />
    </>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800">
      {options.map((o) => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={clsx(
              'h-7 px-2.5 rounded-sm text-[14px] cursor-pointer',
              active
                ? 'bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900'
                : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
      <div className="text-[14px] text-neutral-400">{label}</div>
      <div className="text-[20px] font-semibold text-neutral-900 dark:text-neutral-100 tracking-tight mt-0.5">
        {value}
      </div>
    </div>
  )
}

function Breakdown({
  title,
  rows,
  label,
  loading,
}: {
  title: string
  rows: UsageRow[]
  label: (key: string) => string
  loading?: boolean
}) {
  const maxTokens = rows.length > 0 ? Math.max(...rows.map((r) => r.input_tokens + r.output_tokens)) || 1 : 1
  return (
    <section>
      <div className="text-[14px] font-semibold uppercase tracking-wider text-neutral-400 mb-1.5">
        {title}
      </div>
      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 divide-y divide-neutral-100 dark:divide-neutral-800">
        {loading ? (
          <div className="px-3 py-4 text-[14px] text-neutral-400 text-center">loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-[14px] text-neutral-400 text-center">
            아직 기록된 사용량이 없습니다. 에이전트가 실제 턴을 실행하면 여기 쌓입니다.
          </div>
        ) : (
          rows.map((r) => {
            const total = r.input_tokens + r.output_tokens
            const pct = (total / maxTokens) * 100
            return (
              <div key={r.key} className="px-3 py-2">
                <div className="flex items-center justify-between gap-2 text-[14px]">
                  <span className="truncate text-neutral-800 dark:text-neutral-100">
                    {label(r.key)}
                  </span>
                  <span className="text-neutral-500 font-mono text-[14px]">
                    {fmtTokens(total)} · {fmtCost(r.cost_cents)}
                  </span>
                </div>
                <div className="h-1 bg-neutral-100 dark:bg-neutral-800 rounded-sm overflow-hidden mt-1">
                  <div className="h-full bg-amber-400" style={{ width: `${pct}%` }} />
                </div>
                <div className="text-[14px] text-neutral-400 font-mono mt-0.5">
                  in {fmtTokens(r.input_tokens)} · out {fmtTokens(r.output_tokens)} · {r.n} calls
                </div>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
