import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { listForSession as listArtifactsForSession } from '@/lib/server/artifacts'
import { getSession, sessionDir } from '@/lib/server/sessions'
import { usageForSession } from '@/lib/server/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  // Artifact ids come from the session's artifacts.json index — the session
  // page needs them for /api/artifacts/{id}/download.
  const artifacts = listArtifactsForSession(sessionId).map((a) => ({
    id: a.id,
    filename: a.filename,
    size: a.size,
    mime: a.mime,
  }))
  const usage = usageForSession(sessionId)
  return NextResponse.json({
    ...meta,
    transcript: readJsonl(transcriptPath),
    events: readJsonl(eventsPath),
    artifacts,
    usage,
  })
}
