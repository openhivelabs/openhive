import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/server/db'
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
  // Return DB-backed artifacts with ids (downloadable), not raw fs entries —
  // the session page needs the artifact id for /api/artifacts/{id}/download.
  const artifacts = getDb()
    .prepare(
      `SELECT id, filename, size, mime
         FROM artifacts WHERE session_id = ?
         ORDER BY created_at ASC`,
    )
    .all(sessionId) as { id: string; filename: string; size: number | null; mime: string | null }[]
  const usage = usageForSession(sessionId)
  return NextResponse.json({
    ...meta,
    transcript: readJsonl(transcriptPath),
    events: readJsonl(eventsPath),
    artifacts,
    usage,
  })
}
