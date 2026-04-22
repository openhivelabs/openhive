import { NextResponse } from 'next/server'
import { listAgentGallery } from '@/lib/server/agent-frames'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listAgentGallery())
}
