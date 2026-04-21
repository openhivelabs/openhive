import yaml from 'js-yaml'
import { NextResponse } from 'next/server'
import { buildFrame } from '@/lib/server/frames'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FILENAME_SAFE = /[^A-Za-z0-9._-]+/g

function safeFilename(name: string): string {
  const base = name.replace(FILENAME_SAFE, '-').replace(/^-+|-+$/g, '') || 'team'
  return `${base}.openhive-frame.yaml`
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ companySlug: string; teamSlug: string }> },
) {
  const { companySlug, teamSlug } = await ctx.params
  let frame
  try {
    frame = buildFrame(companySlug, teamSlug)
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    const status = code === 'ENOENT' ? 404 : 400
    return NextResponse.json({ detail: message }, { status })
  }
  const body = yaml.dump(frame, { noRefs: true, sortKeys: false })
  const filename = safeFilename(frame.name || teamSlug)
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/x-yaml',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
