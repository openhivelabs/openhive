import { NextResponse } from 'next/server'
import { summary, type UsagePeriod } from '@/lib/server/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_PERIODS: readonly UsagePeriod[] = ['24h', '7d', '30d', 'all'] as const

export async function GET(req: Request) {
  const url = new URL(req.url)
  const raw = url.searchParams.get('period') ?? 'all'
  const period = (VALID_PERIODS as readonly string[]).includes(raw)
    ? (raw as UsagePeriod)
    : null
  if (!period) {
    return NextResponse.json(
      { detail: `invalid period '${raw}'` },
      { status: 422 },
    )
  }
  return NextResponse.json(summary(period))
}
