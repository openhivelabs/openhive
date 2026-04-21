import { attach, END, isActive } from '@/lib/server/engine/run-registry'
import { eventsFor } from '@/lib/server/runs-store'

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
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params
  if (!isActive(runId)) {
    // Finished or unknown — replay from DB. 404 only when neither.
    const events = eventsFor(runId)
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
      const attached = attach(runId)
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
          for (const row of eventsFor(runId)) {
            controller.enqueue(
              sseFrame({
                kind: row.kind,
                ts: row.ts,
                run_id: runId,
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
