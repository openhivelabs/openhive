import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getArtifact } from '@/lib/server/artifacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function revealInFinder(absPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform
    let cmd: string
    let args: string[]
    if (platform === 'darwin') {
      // Reveal the file itself in Finder (select it inside its parent folder).
      cmd = 'open'
      args = ['-R', absPath]
    } else if (platform === 'win32') {
      cmd = 'explorer'
      args = [`/select,${absPath}`]
    } else {
      // Linux / other: best we can do is open the parent directory.
      cmd = 'xdg-open'
      args = [path.dirname(absPath)]
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', reject)
    child.unref()
    // We don't wait for the process — detached and we don't care about exit
    // code (Windows `explorer /select` returns 1 even on success).
    resolve()
  })
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ artifactId: string }> },
) {
  const { artifactId } = await ctx.params
  const art = getArtifact(artifactId)
  if (!art) {
    return NextResponse.json({ detail: 'Artifact not found' }, { status: 404 })
  }
  if (!fs.existsSync(art.path)) {
    return NextResponse.json(
      { detail: 'Artifact file missing on disk' },
      { status: 410 },
    )
  }
  try {
    await revealInFinder(art.path)
    return NextResponse.json({ ok: true })
  } catch (exc) {
    return NextResponse.json(
      { detail: exc instanceof Error ? exc.message : String(exc) },
      { status: 500 },
    )
  }
}
