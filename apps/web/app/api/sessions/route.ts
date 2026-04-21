import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import {
  getSession,
  listSessions,
  sessionArtifactDir,
  sessionUuidForRun,
} from '@/lib/server/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const runId = url.searchParams.get('run_id')
  if (runId) {
    // Resolve the session for a given engine run id. Lets the task-detail
    // modal fetch its run's output + artifacts without knowing the uuid.
    const uuid = sessionUuidForRun(runId)
    if (!uuid) return NextResponse.json({ detail: 'session not found' }, { status: 404 })
    const meta = getSession(uuid)
    if (!meta) return NextResponse.json({ detail: 'session not found' }, { status: 404 })
    const artDir = sessionArtifactDir(uuid)
    const artifacts = fs.existsSync(artDir)
      ? fs.readdirSync(artDir).map((name) => {
          const full = path.join(artDir, name)
          const st = fs.statSync(full)
          return { name, size: st.size, path: full }
        })
      : []
    return NextResponse.json({ ...meta, artifacts })
  }
  const limit = Number(url.searchParams.get('limit') ?? 100)
  return NextResponse.json(listSessions(Number.isFinite(limit) ? limit : 100))
}
