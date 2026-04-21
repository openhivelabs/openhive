import { NextResponse } from 'next/server'
import { FilesError, readFile } from '@/lib/server/files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const rel = new URL(req.url).searchParams.get('path')
  if (!rel) {
    return NextResponse.json({ detail: 'path query required' }, { status: 400 })
  }
  try {
    return NextResponse.json(readFile(teamId, rel))
  } catch (err) {
    if (err instanceof FilesError) {
      return NextResponse.json({ detail: err.message }, { status: err.statusCode })
    }
    throw err
  }
}
