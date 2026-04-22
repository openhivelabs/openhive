import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { listForSession as listArtifactsForSession } from '@/lib/server/artifacts'
import {
  buildTranscript,
  deleteSession,
  eventsForSession,
  getSession,
  sessionDir,
  updateMeta,
} from '@/lib/server/sessions'
import { usageForSession } from '@/lib/server/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface EventRow {
  kind: string
  tool_call_id?: string | null
  data?: Record<string, unknown>
  data_json?: string
}

/** Walk events oldest → newest. The latest `user_question` whose `tool_call_id`
 *  has no matching `user_answered` is still live — surface it so the session
 *  page can render the answer modal even on direct navigation. */
function pendingAskFromEvents(events: EventRow[]): {
  toolCallId: string
  questions: unknown[]
  agentRole?: string
} | null {
  let latest: {
    toolCallId: string
    questions: unknown[]
    agentRole?: string
  } | null = null
  const answered = new Set<string>()
  for (const ev of events) {
    const data = ev.data ?? (ev.data_json ? JSON.parse(ev.data_json) as Record<string, unknown> : {})
    if (ev.kind === 'user_question' && ev.tool_call_id) {
      latest = {
        toolCallId: ev.tool_call_id,
        questions: (data.questions as unknown[]) ?? [],
        agentRole: typeof data.agent_role === 'string' ? (data.agent_role as string) : undefined,
      }
    } else if (ev.kind === 'user_answered' && ev.tool_call_id) {
      answered.add(ev.tool_call_id)
    }
  }
  if (!latest) return null
  if (answered.has(latest.toolCallId)) return null
  return latest
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params
  const meta = getSession(sessionId)
  if (!meta) {
    return NextResponse.json({ detail: 'session not found' }, { status: 404 })
  }
  const dir = sessionDir(sessionId)
  const transcriptPath = path.join(dir, 'transcript.jsonl')
  const eventsPath = path.join(dir, 'events.jsonl')
  const readJsonl = (p: string): Record<string, unknown>[] => {
    if (!fs.existsSync(p)) return []
    const txt = fs.readFileSync(p, 'utf8')
    const out: Record<string, unknown>[] = []
    for (const line of txt.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { out.push(JSON.parse(trimmed) as Record<string, unknown>) } catch { /* skip */ }
    }
    return out
  }
  const events = readJsonl(eventsPath)
  // Artifact ids come from the session's artifacts.json index — the session
  // page needs them for /api/artifacts/{id}/download.
  const artifacts = listArtifactsForSession(sessionId).map((a) => ({
    id: a.id,
    filename: a.filename,
    size: a.size,
    mime: a.mime,
  }))
  const usage = usageForSession(sessionId)
  // Pending ask is a property of the EVENT LOG, not meta.status. Any session
  // whose events end with an unanswered user_question has a live tool call
  // the user can still answer — regardless of whether meta says 'running'
  // (live generator) or 'needs_input' (generator died but question remains).
  // `error` sessions are the only category that can't have an answerable ask.
  const pendingAsk = meta.status === 'error'
    ? null
    : pendingAskFromEvents(events as EventRow[])
  // For running chat sessions there is no transcript.jsonl yet — it's only
  // written on finalize. Build one on the fly from events so the chat UI
  // always has a full history, live or historical.
  const transcript = fs.existsSync(transcriptPath)
    ? readJsonl(transcriptPath)
    : buildTranscript(meta.goal, meta.started_at, eventsForSession(sessionId))
  return NextResponse.json({
    ...meta,
    transcript,
    events,
    artifacts,
    usage,
    pending_ask: pendingAsk,
  })
}

/** Mutate a small allowlist of meta fields (title, pinned). Anything else is
 *  ignored. Returns the updated meta so the client can sync without a refetch. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params
  let body: { title?: string | null; pinned?: boolean }
  try {
    body = (await req.json()) as { title?: string | null; pinned?: boolean }
  } catch {
    return NextResponse.json({ detail: 'invalid json' }, { status: 400 })
  }
  const patch: Partial<{ title: string | null; pinned: boolean }> = {}
  if ('title' in body) {
    if (body.title === null) patch.title = null
    else if (typeof body.title === 'string') {
      const trimmed = body.title.trim()
      patch.title = trimmed.length > 0 ? trimmed.slice(0, 200) : null
    }
  }
  if ('pinned' in body && typeof body.pinned === 'boolean') {
    patch.pinned = body.pinned
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ detail: 'no fields to update' }, { status: 400 })
  }
  const next = updateMeta(sessionId, patch)
  if (!next) {
    return NextResponse.json({ detail: 'session not found' }, { status: 404 })
  }
  return NextResponse.json(next)
}

/** Permanently delete the session's on-disk state. After this, GET returns 404
 *  and listForTeam/listSessionsFor no longer include the row. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params
  const existed = deleteSession(sessionId)
  if (!existed) {
    return NextResponse.json({ detail: 'session not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
