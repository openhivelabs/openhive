import fs from 'node:fs'
import path from 'node:path'
import { listForSession as listArtifactsForSession } from '@/lib/server/artifacts'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { resolveAskUser } from '@/lib/server/engine/askuser'
import { validateTeam } from '@/lib/server/engine/preflight'
import { pushUserMessage } from '@/lib/server/engine/session'
import {
  END,
  attach,
  forceEvict,
  isActive,
  resume,
  start as startRegistryRun,
  stop,
} from '@/lib/server/engine/session-registry'
import { toTeamSpec } from '@/lib/server/engine/team'
import {
  appendSessionEvent,
  buildTranscript,
  deleteSession,
  eventsForSession,
  getSession,
  listSessions,
  listSessionsFor,
  sessionDir,
  updateMeta,
} from '@/lib/server/sessions'
import { usageForSession } from '@/lib/server/usage'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

export const sessions = new Hono()

const HEARTBEAT_MS = 15_000

// A live run with no event for this long — unless its last event is a
// legitimate park (turn_finished / user_question) — is a zombie. The engine
// generator died silently (HMR, uncaught rejection) but the registry still
// thinks it's live. Evict so attach falls back to disk replay.
const ZOMBIE_THRESHOLD_MS = 120_000
const IDLE_PARK_KINDS = new Set(['user_question', 'turn_finished'])

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
    const data =
      ev.data ?? (ev.data_json ? (JSON.parse(ev.data_json) as Record<string, unknown>) : {})
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

interface StartBody {
  team?: Record<string, unknown>
  goal?: string
  locale?: string
  task_id?: string
}

interface AnswerBody {
  tool_call_id?: string
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

// GET /api/sessions — list (optionally filtered by team/task)
sessions.get('/', (c) => {
  const teamId = c.req.query('team_id')
  const taskId = c.req.query('task_id')
  const limitRaw = Number(c.req.query('limit') ?? 200)
  const limit = Number.isFinite(limitRaw) ? limitRaw : 200
  if (teamId || taskId) {
    return c.json(
      listSessionsFor({
        teamId: teamId ?? null,
        taskId: taskId ?? null,
        limit,
      }),
    )
  }
  return c.json(listSessions(limit))
})

// POST /api/sessions/start — spawn a new engine run, return session_id
sessions.post('/start', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StartBody
  if (!body.team || typeof body.team !== 'object') {
    return c.json({ detail: 'team required' }, 400)
  }
  if (typeof body.goal !== 'string' || !body.goal.trim()) {
    return c.json({ detail: 'goal required' }, 400)
  }
  const team = toTeamSpec(body.team)
  const issues = validateTeam(team)
  if (issues.length > 0) {
    return c.json({ detail: { preflight: issues } }, 400)
  }
  const resolved = resolveTeamSlugs(team.id)
  const teamSlugs: [string, string] | null = resolved
    ? [resolved.companySlug, resolved.teamSlug]
    : null
  try {
    const sessionId = await startRegistryRun(
      team,
      body.goal,
      teamSlugs,
      body.locale ?? 'en',
      typeof body.task_id === 'string' && body.task_id ? body.task_id : null,
    )
    return c.json({ session_id: sessionId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 500)
  }
})

// POST /api/sessions/answer — resolve a pending ask_user (or resume-as-answer)
sessions.post('/answer', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as AnswerBody
  if (typeof body.tool_call_id !== 'string' || !body.tool_call_id) {
    return c.json({ detail: 'tool_call_id required' }, 400)
  }

  // Fast path: live engine has a pending ask_user — resolve the promise and
  // let the engine continue normally. Emits user_answered via the tool's
  // post-resolve hook in session.ts.
  const ok = resolveAskUser(body.tool_call_id, {
    answers: body.answers ?? {},
    skipped: !!body.skipped,
  })
  if (ok) return c.json({ ok: true, resumed: false })

  // resolveAskUser failed. Either (a) engine is dead and we need to resume,
  // or (b) engine is alive but this tool_call_id is already past — a stale
  // retry from the UI. Treat (b) as success so the client can clear its
  // local pending_ask without seeing a spurious error.
  if (!body.session_id) {
    return c.json({ detail: 'No pending question for that tool_call_id' }, 404)
  }
  const meta = getSession(body.session_id)
  if (!meta) {
    return c.json({ detail: 'session not found' }, 404)
  }
  const events = eventsForSession(body.session_id)
  const alreadyAnswered = events.some(
    (e) => e.kind === 'user_answered' && e.tool_call_id === body.tool_call_id,
  )
  if (alreadyAnswered) {
    return c.json({ ok: true, resumed: false, already: true })
  }
  if (isActive(body.session_id)) {
    return c.json({ ok: true, resumed: false, already: true })
  }

  if (!meta.team_snapshot) {
    return c.json({ detail: 'session predates resume support — start a new chat' }, 409)
  }
  const hasMatchingQuestion = events.some(
    (e) => e.kind === 'user_question' && e.tool_call_id === body.tool_call_id,
  )
  if (!hasMatchingQuestion) {
    return c.json({ detail: 'No pending question for that tool_call_id' }, 404)
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
    return c.json({ detail: 'resume failed — session may have been deleted' }, 409)
  }
  return c.json({ ok: true, resumed: true })
})

interface StreamBody {
  team?: Record<string, unknown>
  goal?: string
  locale?: string
}

/** Backwards-compat: launch the run and stream it in one call. New clients
 *  should prefer POST /start + GET /:session_id/stream so refreshes can reattach. */
sessions.post('/stream', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StreamBody
  if (!body.team || typeof body.team !== 'object') {
    return c.json({ detail: 'team required' }, 400)
  }
  if (typeof body.goal !== 'string' || !body.goal.trim()) {
    return c.json({ detail: 'goal required' }, 400)
  }
  const team = toTeamSpec(body.team)
  const issues = validateTeam(team)
  if (issues.length > 0) {
    return c.json({ detail: { preflight: issues } }, 400)
  }
  const resolved = resolveTeamSlugs(team.id)
  const teamSlugs: [string, string] | null = resolved
    ? [resolved.companySlug, resolved.teamSlug]
    : null

  let sessionId: string
  try {
    sessionId = await startRegistryRun(team, body.goal, teamSlugs, body.locale ?? 'en')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 500)
  }

  // X-Accel-Buffering is critical when fronted by nginx; Hono's streamSSE
  // sets Content-Type + Cache-Control itself, but not this one.
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    let detach: (() => void) | null = null
    const cleanup = () => {
      if (detach) {
        detach()
        detach = null
      }
    }
    stream.onAbort(cleanup)

    const attached = attach(sessionId)
    if (!attached) {
      await stream.writeSSE({ data: '[DONE]' })
      return
    }
    detach = attached.detach
    try {
      for (const ev of attached.snapshot) {
        await stream.writeSSE({ data: JSON.stringify(ev) })
      }
      let lastWrite = Date.now()
      const heartbeat = setInterval(() => {
        if (Date.now() - lastWrite >= HEARTBEAT_MS) {
          // SSE comment — keepalive with no event payload
          stream.write(': keepalive\n\n').catch(() => {})
          lastWrite = Date.now()
        }
      }, HEARTBEAT_MS)
      try {
        while (true) {
          const item = await attached.queue.pop()
          if (item === END) break
          await stream.writeSSE({ data: JSON.stringify(item) })
          lastWrite = Date.now()
        }
      } finally {
        clearInterval(heartbeat)
      }
      await stream.writeSSE({ data: '[DONE]' })
    } finally {
      cleanup()
    }
  })
})

// GET /api/sessions/:sessionId — full session detail (meta + transcript +
// events + artifacts + usage + pending_ask)
sessions.get('/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId')
  const meta = getSession(sessionId)
  if (!meta) {
    return c.json({ detail: 'session not found' }, 404)
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
      try {
        out.push(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        /* skip */
      }
    }
    return out
  }
  const events = readJsonl(eventsPath)
  const artifacts = listArtifactsForSession(sessionId).map((a) => ({
    id: a.id,
    filename: a.filename,
    size: a.size,
    mime: a.mime,
  }))
  const usage = usageForSession(sessionId)
  const pendingAsk =
    meta.status === 'error' ? null : pendingAskFromEvents(events as unknown as EventRow[])
  const transcript = fs.existsSync(transcriptPath)
    ? readJsonl(transcriptPath)
    : buildTranscript(meta.goal, meta.started_at, eventsForSession(sessionId))
  return c.json({
    ...meta,
    transcript,
    events,
    artifacts,
    usage,
    pending_ask: pendingAsk,
  })
})

// PATCH /api/sessions/:sessionId — mutate allowlisted meta (title, pinned)
sessions.patch('/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  let body: { title?: string | null; pinned?: boolean }
  try {
    body = (await c.req.json()) as { title?: string | null; pinned?: boolean }
  } catch {
    return c.json({ detail: 'invalid json' }, 400)
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
    return c.json({ detail: 'no fields to update' }, 400)
  }
  const next = updateMeta(sessionId, patch)
  if (!next) {
    return c.json({ detail: 'session not found' }, 404)
  }
  return c.json(next)
})

// DELETE /api/sessions/:sessionId — permanent
sessions.delete('/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId')
  const existed = deleteSession(sessionId)
  if (!existed) {
    return c.json({ detail: 'session not found' }, 404)
  }
  return c.json({ ok: true })
})

// GET /api/sessions/:sessionId/events — raw events list
sessions.get('/:sessionId/events', (c) => {
  const sessionId = c.req.param('sessionId')
  return c.json(eventsForSession(sessionId))
})

interface MessageBody {
  text?: string
  locale?: string
}

// POST /api/sessions/:sessionId/messages — push follow-up or resume-as-message
sessions.post('/:sessionId/messages', async (c) => {
  const sessionId = c.req.param('sessionId')
  const meta = getSession(sessionId)
  if (!meta) {
    return c.json({ detail: 'session not found' }, 404)
  }
  const body = (await c.req.json().catch(() => ({}))) as MessageBody
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) {
    return c.json({ detail: 'text required' }, 400)
  }

  // Fast path: generator is live, push to inbox.
  if (isActive(sessionId)) {
    const delivered = pushUserMessage(sessionId, text)
    if (!delivered) {
      return c.json({ detail: 'session inbox unavailable' }, 409)
    }
    return c.json({ ok: true, resumed: false })
  }

  // Slow path: generator died — resurrect from team snapshot + events.
  if (!meta.team_snapshot) {
    return c.json({ detail: 'session predates resume support — start a new chat' }, 409)
  }
  if (meta.status === 'error') {
    return c.json({ detail: 'session ended in error — start a new chat' }, 409)
  }

  const locale = typeof body.locale === 'string' ? body.locale : 'en'
  const ok = await resume(meta.team_snapshot, sessionId, text, null, locale)
  if (!ok) {
    return c.json({ detail: 'resume failed — session may have been deleted' }, 409)
  }
  return c.json({ ok: true, resumed: true })
})

// POST /api/sessions/:sessionId/stop — cancel an active run
sessions.post('/:sessionId/stop', async (c) => {
  const sessionId = c.req.param('sessionId')
  return c.json({ ok: await stop(sessionId) })
})

// GET /api/sessions/:sessionId/stream — SSE subscription. Attaches to the
// engine's event bus (live snapshot + future events) or replays from disk
// for idle/completed sessions. Never synthesizes terminal events — idle
// sessions are resumable, so forcing `[DONE]` with a fake terminal would
// lie to the UI about whether the chat is finished.
sessions.get('/:sessionId/stream', (c) => {
  const sessionId = c.req.param('sessionId')

  // Zombie check — live run with stale last event that isn't a legit park
  // means the generator died silently. Evict so attach replays from disk.
  if (isActive(sessionId)) {
    try {
      const allEvents = eventsForSession(sessionId)
      const latest = allEvents[allEvents.length - 1]
      if (latest) {
        const ageMs = Date.now() - latest.ts * 1000
        if (ageMs > ZOMBIE_THRESHOLD_MS && !IDLE_PARK_KINDS.has(latest.kind)) {
          forceEvict(sessionId)
        }
      }
    } catch {
      /* best-effort */
    }
  }
  if (!isActive(sessionId)) {
    if (!getSession(sessionId) && eventsForSession(sessionId).length === 0) {
      return c.json({ detail: 'run not found' }, 404)
    }
  }

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    let detach: (() => void) | null = null
    const cleanup = () => {
      if (detach) {
        detach()
        detach = null
      }
    }
    stream.onAbort(cleanup)

    const attached = attach(sessionId)
    if (attached) {
      detach = attached.detach
      try {
        for (const ev of attached.snapshot) {
          await stream.writeSSE({ data: JSON.stringify(ev) })
        }
        let lastWrite = Date.now()
        const heartbeat = setInterval(() => {
          if (Date.now() - lastWrite >= HEARTBEAT_MS) {
            stream.write(': keepalive\n\n').catch(() => {})
            lastWrite = Date.now()
          }
        }, HEARTBEAT_MS)
        try {
          while (true) {
            const item = await attached.queue.pop()
            if (item === END) break
            await stream.writeSSE({ data: JSON.stringify(item) })
            lastWrite = Date.now()
          }
        } finally {
          clearInterval(heartbeat)
        }
      } finally {
        cleanup()
      }
    } else {
      // Replay from disk — no synthesis.
      try {
        const rows = eventsForSession(sessionId)
        for (const row of rows) {
          await stream.writeSSE({
            data: JSON.stringify({
              kind: row.kind,
              ts: row.ts,
              session_id: sessionId,
              depth: row.depth,
              node_id: row.node_id,
              tool_call_id: row.tool_call_id,
              tool_name: row.tool_name,
              data: row.data,
            }),
          })
        }
      } catch {
        /* client gone */
      }
    }
    await stream.writeSSE({ data: '[DONE]' })
  })
})
