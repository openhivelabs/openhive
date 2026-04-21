import { attach, END, isActive } from '@/lib/server/engine/run-registry'
import { eventsFor } from '@/lib/server/runs-store'
import { getDb } from '@/lib/server/db'

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
          const rows = eventsFor(runId)
          for (const row of rows) {
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
          // If the stored event log doesn't include a terminal marker (common
          // for runs whose server process died mid-flight), synthesize one
          // from the runs-table status so clients stop waiting on a stream
          // that will never produce another real event.
          const alreadyTerminal = rows.some(
            (r) => r.kind === 'run_finished' || r.kind === 'run_error',
          )
          if (!alreadyTerminal) {
            const row = getDb()
              .prepare('SELECT status, output, error FROM runs WHERE id = ?')
              .get(runId) as
              | { status: string; output: string | null; error: string | null }
              | undefined
            if (row && row.status !== 'running') {
              controller.enqueue(
                sseFrame({
                  kind: row.error ? 'run_error' : 'run_finished',
                  ts: Date.now() / 1000,
                  run_id: runId,
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
