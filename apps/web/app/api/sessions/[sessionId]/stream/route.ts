import { attach, END, forceEvict, isActive } from '@/lib/server/engine/session-registry'
import { eventsForSession, getSession } from '@/lib/server/sessions'

// An "active" run with no event for this long AND whose last event isn't a
// legitimate park (turn_finished / user_question) is a true zombie — the
// engine generator died silently (HMR, uncaught rejection) but the registry
// still thinks it's live. Evict so the next attach goes through the replay
// path and the session shows as idle (resumable via POST /messages).
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
    // Replay from disk. We no longer synthesize terminal events here — the
    // session is either idle (resumable; no terminal needed, client exits
    // on [DONE]) or error (run_error already on disk from driveSession).
    // Orphaned 'running' sessions are demoted to 'idle' at boot, so they
    // also land in the idle-replay branch.
    if (!getSession(sessionId) && eventsForSession(sessionId).length === 0) {
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
        // Replay from disk — no synthesis. Idle sessions are resumable, so
        // forcing a terminal here would lie to the UI ("this chat is done").
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
