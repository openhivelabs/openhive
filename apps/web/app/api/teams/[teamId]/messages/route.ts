import { NextResponse } from 'next/server'
import {
  clearTeam,
  listForTeam,
  nowTs,
  saveMessage,
  type MessageRecord,
} from '@/lib/server/messages'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  return NextResponse.json(listForTeam(teamId))
}

interface AppendBody {
  id?: string
  from_id?: string
  text?: string
  run_id?: string | null
  created_at?: number | null
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const body = (await req.json()) as AppendBody
  if (!body.id || !body.from_id || typeof body.text !== 'string') {
    return NextResponse.json(
      { detail: 'id, from_id, text required' },
      { status: 400 },
    )
  }
  const record: MessageRecord = {
    id: body.id,
    team_id: teamId,
    from_id: body.from_id,
    text: body.text,
    run_id: body.run_id ?? null,
    created_at: body.created_at ?? nowTs(),
  }
  saveMessage(record)
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params
  const cleared = clearTeam(teamId)
  return NextResponse.json({ ok: true, cleared })
}
