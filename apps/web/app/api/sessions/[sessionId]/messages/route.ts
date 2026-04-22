import { NextResponse } from 'next/server'
import { pushUserMessage } from '@/lib/server/engine/session'
import { isActive, resume } from '@/lib/server/engine/session-registry'
import { getSession } from '@/lib/server/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  text?: string
  locale?: string
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

  // Fast path: generator is live, just push onto the inbox.
  if (isActive(sessionId)) {
    const delivered = pushUserMessage(sessionId, text)
    if (!delivered) {
      return NextResponse.json(
        { detail: 'session inbox unavailable' },
        { status: 409 },
      )
    }
    return NextResponse.json({ ok: true, resumed: false })
  }

  // Slow path: generator died (process restart, HMR, crash). Resurrect it
  // from the team snapshot + events.jsonl history, then inject the new
  // user message as its first turn.
  if (!meta.team_snapshot) {
    // Legacy session (pre team-snapshot). Can't resume — the engine needs
    // the TeamSpec to rebuild tools/delegation graph. Surface cleanly so
    // the UI can tell the user "this chat is too old to continue."
    return NextResponse.json(
      { detail: 'session predates resume support — start a new chat' },
      { status: 409 },
    )
  }
  if (meta.status === 'error') {
    return NextResponse.json(
      { detail: 'session ended in error — start a new chat' },
      { status: 409 },
    )
  }

  const locale = typeof body.locale === 'string' ? body.locale : 'en'
  const ok = await resume(meta.team_snapshot, sessionId, text, null, locale)
  if (!ok) {
    return NextResponse.json(
      { detail: 'resume failed — session may have been deleted' },
      { status: 409 },
    )
  }
  return NextResponse.json({ ok: true, resumed: true })
}
