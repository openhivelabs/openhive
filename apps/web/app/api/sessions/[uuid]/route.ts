import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getSession, sessionArtifactDir, sessionDir } from '@/lib/server/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await ctx.params
  const meta = getSession(uuid)
  if (!meta) {
    return NextResponse.json({ detail: 'session not found' }, { status: 404 })
  }
  const dir = sessionDir(uuid)
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
  const artDir = sessionArtifactDir(uuid)
  const artifacts = fs.existsSync(artDir)
    ? fs.readdirSync(artDir).map((name) => {
        const full = path.join(artDir, name)
        const st = fs.statSync(full)
        return { name, size: st.size, path: full }
      })
    : []
  return NextResponse.json({
    meta,
    transcript: readJsonl(transcriptPath),
    events: readJsonl(eventsPath),
    artifacts,
  })
}
