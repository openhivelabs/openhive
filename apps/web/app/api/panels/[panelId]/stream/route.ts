import { get } from '@/lib/server/panels/cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const POLL_INTERVAL_MS = 1000

function sseFrame(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

/**
 * SSE stream that pushes the panel's cache row whenever its fetched_at
 * advances. Polling the DB every ~1s is cheap and avoids wiring a
 * cross-process pubsub just for this UI feature.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ panelId: string }> },
) {
  const { panelId } = await ctx.params
  const abort = new AbortController()
  req.signal?.addEventListener('abort', () => abort.abort())

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastTs: number | null = null
      const initial = get(panelId)
      if (initial) {
        lastTs = initial.fetched_at
        controller.enqueue(sseFrame(initial))
      }
      while (!abort.signal.aborted) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        if (abort.signal.aborted) break
        const row = get(panelId)
        if (!row) continue
        if (lastTs === null || row.fetched_at > lastTs) {
          lastTs = row.fetched_at
          controller.enqueue(sseFrame(row))
        }
      }
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
