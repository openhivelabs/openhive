import { NextResponse } from 'next/server'
import { testConnection } from '@/lib/server/mcp/manager'
import { getPreset, materialise } from '@/lib/server/mcp/presets'
import type { ServerConfig } from '@/lib/server/mcp/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  server?: Partial<ServerConfig> | null
  preset_id?: string | null
  inputs?: Record<string, string> | null
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body
  let server: ServerConfig
  if (body.preset_id) {
    const preset = getPreset(body.preset_id)
    if (!preset) {
      return NextResponse.json({ detail: 'unknown preset' }, { status: 404 })
    }
    server = materialise(preset, body.inputs ?? {})
  } else if (body.server) {
    const raw = body.server
    if (!raw.command) {
      return NextResponse.json({ detail: 'server.command required' }, { status: 400 })
    }
    server = {
      command: String(raw.command),
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env:
        raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
          ? Object.fromEntries(
              Object.entries(raw.env).map(([k, v]) => [k, String(v)]),
            )
          : {},
    }
  } else {
    return NextResponse.json(
      { detail: 'provide either preset_id+inputs or server' },
      { status: 400 },
    )
  }
  return NextResponse.json(await testConnection(server))
}
