import { NextResponse } from 'next/server'
import { pushUserMessage } from '@/lib/server/engine/session'
import { isActive } from '@/lib/server/engine/session-registry'
import { getSession } from '@/lib/server/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  text?: string
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params
  const meta = getSession(sessionId)
  if (!meta) {
    return NextResponse.json({ detail: 'session not found' }, { status: 404 })
  }
  const body = (await req.json().catch(() => ({}))) as Body
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) {
    return NextResponse.json({ detail: 'text required' }, { status: 400 })
  }
  if (!isActive(sessionId)) {
    // The engine already exited (stop / error / pre-chat-loop builds). There
    // is nothing to re-enter; the UI should surface this as an ended chat.
    return NextResponse.json(
      { detail: 'session is not live — cannot send follow-up message' },
      { status: 409 },
    )
  }
  const delivered = pushUserMessage(sessionId, text)
  if (!delivered) {
    return NextResponse.json(
      { detail: 'session inbox unavailable' },
      { status: 409 },
    )
  }
  return NextResponse.json({ ok: true })
}
