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
  _req: Request,
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const attached = attach(runId)
      if (attached) {
        for (const ev of attached.snapshot) controller.enqueue(sseFrame(ev))
        let timer: NodeJS.Timeout | null = null
        const resetTimer = () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            controller.enqueue(keepaliveFrame())
            resetTimer()
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
        } finally {
          if (timer) clearTimeout(timer)
        }
      } else {
        // Replay from DB.
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
      }
      controller.enqueue(doneFrame())
      controller.close()
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
