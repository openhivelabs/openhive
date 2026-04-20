import { NextResponse } from 'next/server'
import { upsertServer } from '@/lib/server/mcp/config'
import { restart } from '@/lib/server/mcp/manager'
import { getPreset, materialise } from '@/lib/server/mcp/presets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  preset_id?: string
  name?: string
  inputs?: Record<string, string>
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body
  if (typeof body.preset_id !== 'string' || !body.preset_id) {
    return NextResponse.json({ detail: 'preset_id required' }, { status: 400 })
  }
  if (typeof body.name !== 'string' || !body.name) {
    return NextResponse.json({ detail: 'name required' }, { status: 400 })
  }
  const preset = getPreset(body.preset_id)
  if (!preset) {
    return NextResponse.json(
      { detail: `unknown preset ${JSON.stringify(body.preset_id)}` },
      { status: 404 },
    )
  }
  if (preset.coming_soon) {
    return NextResponse.json(
      { detail: 'this preset is coming soon — not yet available' },
      { status: 400 },
    )
  }
  const inputs = body.inputs ?? {}
  const missing = preset.inputs
    .filter((i) => i.required && !inputs[i.key])
    .map((i) => i.key)
  if (missing.length > 0) {
    return NextResponse.json(
      { detail: `missing inputs: ${JSON.stringify(missing)}` },
      { status: 400 },
    )
  }
  const server = materialise(preset, inputs)
  try {
    upsertServer(body.name, server)
  } catch (err) {
    return NextResponse.json(
      { detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    )
  }
  await restart(body.name)
  return NextResponse.json({ ok: true, name: body.name })
}
