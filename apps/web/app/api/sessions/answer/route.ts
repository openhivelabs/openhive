import { NextResponse } from 'next/server'
import { resolveAskUser } from '@/lib/server/engine/askuser'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AnswerBody {
  tool_call_id?: string
  answers?: Record<string, unknown> | null
  skipped?: boolean
}

export async function POST(req: Request) {
  const body = (await req.json()) as AnswerBody
  if (typeof body.tool_call_id !== 'string' || !body.tool_call_id) {
    return NextResponse.json({ detail: 'tool_call_id required' }, { status: 400 })
  }
  const ok = resolveAskUser(body.tool_call_id, {
    answers: body.answers ?? {},
    skipped: !!body.skipped,
  })
  if (!ok) {
    return NextResponse.json(
      { detail: 'No pending question for that tool_call_id' },
      { status: 404 },
    )
  }
  return NextResponse.json({ ok: true })
}
