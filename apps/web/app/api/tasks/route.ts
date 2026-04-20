import { NextResponse } from 'next/server'
import { listTasks } from '@/lib/server/tasks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listTasks())
}
