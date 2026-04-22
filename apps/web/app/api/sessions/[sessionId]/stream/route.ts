import { attach, END, forceEvict, isActive } from '@/lib/server/engine/session-registry'
import { eventsForSession, finishSession, getSession } from '@/lib/server/sessions'

// An "active" run with no event for this long is a zombie — the engine
// generator died silently (HMR, uncaught rejection) but the registry
// still thinks it's live. We evict + reconcile on the next reconnect.
// Exclusions: kinds that legitimately park for arbitrary durations.
//   - user_question: waiting on ask_user answer
//   - turn_finished: chat session parked on inbox.pop() awaiting the next
//     user message (see engine/session.ts runTeamBody loop)
const ZOMBIE_THRESHOLD_MS = 120_000
const IDLE_PARK_KINDS = new Set(['user_question', 'turn_finished'])

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEARTBEAT_MS = 15_000

function sseFrame(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

function keepaliveFrame(): Uint8Array {
  return new TextEncoder().encode(': keepalive\n\n')
}

function doneFrame(): Uint8Array {
  return new TextEncoder().encode('data: [DONE]\n\n')
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params
  if (isActive(sessionId)) {
    // Staleness sniff: if the registry thinks this run is live but no
    // event has been appended in >120s and the last event wasn't an
    // ask_user, the engine generator is effectively dead. Evict so the
    // replay/reconcile path can mark it interrupted.
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
    // Finished or unknown — replay from DB. 404 only when neither.
    const events = eventsForSession(sessionId)
    if (events.length === 0) {
      return new Response(JSON.stringify({ detail: 'run not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  // Capture detach outside start() so both cancel() and req.signal can call it.
  let detach: (() => void) | null = null
  const onAbort = () => {
    if (detach) {
      detach()
      detach = null
    }
  }
  req.signal.addEventListener('abort', onAbort)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const attached = attach(sessionId)
      if (attached) {
        detach = attached.detach
        for (const ev of attached.snapshot) {
          try {
            controller.enqueue(sseFrame(ev))
          } catch {
            onAbort()
            return
          }
        }
        let timer: NodeJS.Timeout | null = null
        const resetTimer = () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            try {
              controller.enqueue(keepaliveFrame())
              resetTimer()
            } catch {
              onAbort()
            }
          }, HEARTBEAT_MS)
        }
        resetTimer()
        try {
          while (true) {
            const item = await attached.queue.pop()
            if (item === END) break
            controller.enqueue(sseFrame(item))
            resetTimer()
          }
        } catch {
          // Client disconnected mid-enqueue. Just fall through to finally.
        } finally {
          if (timer) clearTimeout(timer)
          onAbort()
        }
      } else {
        // Replay from DB.
        try {
          const rows = eventsForSession(sessionId)
          for (const row of rows) {
            controller.enqueue(
              sseFrame({
                kind: row.kind,
                ts: row.ts,
                session_id: sessionId,
                depth: row.depth,
                node_id: row.node_id,
                tool_call_id: row.tool_call_id,
                tool_name: row.tool_name,
                data: row.data,
              }),
            )
          }
          // If the stored event log doesn't include a terminal marker (common
          // for runs whose server process died mid-flight), synthesize one
          // from the runs-table status so clients stop waiting on a stream
          // that will never produce another real event.
          const alreadyTerminal = rows.some(
            (r) => r.kind === 'run_finished' || r.kind === 'run_error',
          )
          if (!alreadyTerminal) {
            let meta = getSession(sessionId)
            // Zombie reconciliation: the engine isn't running this session
            // (isActive=false checked above) but meta.json still says
            // 'running' — engine process died mid-flight. Mark it
            // interrupted so the UI stops spinning forever.
            if (meta && meta.status === 'running') {
              try { await finishSession(sessionId, { error: 'interrupted' }) }
              catch { /* best-effort */ }
              meta = { ...meta, status: 'interrupted', error: 'interrupted' }
            }
            const row = meta
              ? { status: meta.status, output: meta.output, error: meta.error }
              : undefined
            if (row && row.status !== 'running') {
              controller.enqueue(
                sseFrame({
                  kind: row.error ? 'run_error' : 'run_finished',
                  ts: Date.now() / 1000,
                  session_id: sessionId,
                  depth: 0,
                  node_id: null,
                  tool_call_id: null,
                  tool_name: null,
                  data: row.error
                    ? { error: row.error }
                    : { output: row.output ?? '' },
                }),
              )
            }
          }
        } catch {
          /* client gone, drop */
        }
      }
      try {
        controller.enqueue(doneFrame())
        controller.close()
      } catch {
        /* already closed */
      }
      req.signal.removeEventListener('abort', onAbort)
    },
    cancel() {
      onAbort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}
