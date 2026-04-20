import { resolveTeamSlugs } from '@/lib/server/companies'
import { validateTeam } from '@/lib/server/engine/preflight'
import { attach, END, start } from '@/lib/server/engine/run-registry'
import { toTeamSpec } from '@/lib/server/engine/team'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEARTBEAT_MS = 15_000

interface StreamBody {
  team?: Record<string, unknown>
  goal?: string
  locale?: string
}

function sseFrame(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}
function keepaliveFrame(): Uint8Array {
  return new TextEncoder().encode(': keepalive\n\n')
}
function doneFrame(): Uint8Array {
  return new TextEncoder().encode('data: [DONE]\n\n')
}

/** Backwards-compat: launch the run and stream it in one call. New clients
 *  should prefer POST /start + GET /:run_id/stream so refreshes can reattach. */
export async function POST(req: Request) {
  const body = (await req.json()) as StreamBody
  if (!body.team || typeof body.team !== 'object') {
    return new Response(JSON.stringify({ detail: 'team required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (typeof body.goal !== 'string' || !body.goal.trim()) {
    return new Response(JSON.stringify({ detail: 'goal required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const team = toTeamSpec(body.team)
  const issues = validateTeam(team)
  if (issues.length > 0) {
    return new Response(
      JSON.stringify({ detail: { preflight: issues } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const resolved = resolveTeamSlugs(team.id)
  const teamSlugs: [string, string] | null = resolved
    ? [resolved.companySlug, resolved.teamSlug]
    : null

  let runId: string
  try {
    runId = await start(team, body.goal, teamSlugs, body.locale ?? 'en')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ detail: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const attached = attach(runId)
      if (!attached) {
        controller.enqueue(doneFrame())
        controller.close()
        return
      }
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
