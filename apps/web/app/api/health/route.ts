import { NextResponse } from 'next/server'

// Runs on the Node runtime because downstream route handlers (DB, crypto,
// fs) use Node-only APIs. Set it here as a baseline — inherited by siblings.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ status: 'ok', version: '0.0.1' })
}
