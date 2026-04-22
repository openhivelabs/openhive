import { NextResponse } from 'next/server'
import { resolveAskUser } from '@/lib/server/engine/askuser'
import { isActive, resume } from '@/lib/server/engine/session-registry'
import { appendSessionEvent, eventsForSession, getSession } from '@/lib/server/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AnswerBody {
  tool_call_id?: string
  /** Required when answering a question for a non-live session so the server
   *  can resurrect the engine via resume(). Optional when the engine is live
   *  — resolveAskUser() finds the pending promise by tool_call_id alone. */
  session_id?: string
  answers?: Record<string, unknown> | null
  skipped?: boolean
  locale?: string
}

/** Format the answer payload as a natural-language user message. Used when
 *  answering a question on a dead session — the original ask_user tool call
 *  is abandoned, so we replay the answer as a normal follow-up message and
 *  the Lead picks up the conversation from there. */
function answerToText(
  answers: Record<string, unknown> | null | undefined,
  skipped: boolean,
): string {
  if (skipped) return '(skipped)'
  if (!answers || Object.keys(answers).length === 0) return '(no answer)'
  return Object.entries(answers)
    .map(([q, a]) => {
      const answerStr = typeof a === 'string' ? a : JSON.stringify(a)
      return `Q: ${q}\nA: ${answerStr}`
    })
    .join('\n\n')
}

export async function POST(req: Request) {
  const body = (await req.json()) as AnswerBody
  if (typeof body.tool_call_id !== 'string' || !body.tool_call_id) {
    return NextResponse.json({ detail: 'tool_call_id required' }, { status: 400 })
  }

  // Fast path: live engine has a pending ask_user — resolve the promise and
  // let the engine continue normally. Emits user_answered via the tool's
  // post-resolve hook in session.ts.
  const ok = resolveAskUser(body.tool_call_id, {
    answers: body.answers ?? {},
    skipped: !!body.skipped,
  })
  if (ok) return NextResponse.json({ ok: true, resumed: false })

  // resolveAskUser failed. Either (a) engine is dead and we need to resume,
  // or (b) engine is alive but this tool_call_id is already past — a stale
  // retry from the UI. Treat (b) as success so the client can clear its
  // local pending_ask without seeing a spurious error.
  if (!body.session_id) {
    return NextResponse.json(
      { detail: 'No pending question for that tool_call_id' },
      { status: 404 },
    )
  }
  const meta = getSession(body.session_id)
  if (!meta) {
    return NextResponse.json({ detail: 'session not found' }, { status: 404 })
  }
  const events = eventsForSession(body.session_id)
  const alreadyAnswered = events.some(
    (e) => e.kind === 'user_answered' && e.tool_call_id === body.tool_call_id,
  )
  if (alreadyAnswered) {
    return NextResponse.json({ ok: true, resumed: false, already: true })
  }
  if (isActive(body.session_id)) {
    // Engine is running but this tool_call_id isn't pending. It was either
    // answered via a different code path or superseded by a resume that
    // already swallowed the answer text. No-op.
    return NextResponse.json({ ok: true, resumed: false, already: true })
  }

  // Engine is dead — attempt resume-as-answer.
  if (!meta.team_snapshot) {
    return NextResponse.json(
      { detail: 'session predates resume support — start a new chat' },
      { status: 409 },
    )
  }
  const hasMatchingQuestion = events.some(
    (e) => e.kind === 'user_question' && e.tool_call_id === body.tool_call_id,
  )
  if (!hasMatchingQuestion) {
    return NextResponse.json(
      { detail: 'No pending question for that tool_call_id' },
      { status: 404 },
    )
  }
  // Close the dangling ask_user tool call so the reconciler on next boot
  // doesn't re-mark this session as needs_input. The resumed engine won't
  // re-emit user_answered for the original call (that tool promise is gone);
  // we synthesize one here to keep events.jsonl self-consistent.
  const seq = events.length
  try {
    appendSessionEvent({
      sessionId: body.session_id,
      seq,
      ts: Date.now() / 1000,
      kind: 'user_answered',
      depth: 0,
      nodeId: null,
      toolCallId: body.tool_call_id,
      toolName: 'ask_user',
      data: {
        result: body.answers ?? {},
        skipped: !!body.skipped,
        resumed: true,
      },
    })
  } catch {
    /* best-effort — on failure the only downside is a false needs_input on reboot */
  }

  const locale = typeof body.locale === 'string' ? body.locale : 'en'
  const text = answerToText(body.answers, !!body.skipped)
  const resumed = await resume(meta.team_snapshot, body.session_id, text, null, locale)
  if (!resumed) {
    return NextResponse.json(
      { detail: 'resume failed — session may have been deleted' },
      { status: 409 },
    )
  }
  return NextResponse.json({ ok: true, resumed: true })
}
