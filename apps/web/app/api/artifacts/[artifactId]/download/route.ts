import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getArtifact } from '@/lib/server/artifacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ artifactId: string }> },
) {
  const { artifactId } = await ctx.params
  const art = getArtifact(artifactId)
  if (!art) {
    return NextResponse.json({ detail: 'Artifact not found' }, { status: 404 })
  }
  if (!fs.existsSync(art.path) || !fs.statSync(art.path).isFile()) {
    return NextResponse.json(
      { detail: 'Artifact file missing on disk' },
      { status: 410 },
    )
  }
  const stream = fs.createReadStream(art.path) as unknown as ReadableStream
  return new NextResponse(stream, {
    headers: {
      'Content-Type': art.mime ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.basename(art.filename)}"`,
      'Content-Length': String(art.size ?? fs.statSync(art.path).size),
    },
  })
}
