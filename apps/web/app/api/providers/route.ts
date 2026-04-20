import { NextResponse } from 'next/server'
import { PROVIDERS } from '@/lib/server/auth/providers'
import { getAccountLabel, listConnected } from '@/lib/server/tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const connected = new Set(listConnected())
  return NextResponse.json(
    PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      description: p.description,
      connected: connected.has(p.id),
      account_label: connected.has(p.id) ? getAccountLabel(p.id) : null,
    })),
  )
}
