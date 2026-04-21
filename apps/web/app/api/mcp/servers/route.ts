import { NextResponse } from 'next/server'
import { listServers } from '@/lib/server/mcp/config'
import { statusSnapshot } from '@/lib/server/mcp/manager'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const raw = listServers()
  const statuses = statusSnapshot()
  const out = Object.entries(raw).map(([name, srv]) => {
    const st = statuses[name] ?? { running: false, last_error: null, tool_count: null }
    return {
      name,
      preset_id: srv.preset_id ?? null,
      command: srv.command,
      args: srv.args ?? [],
      env_keys: Object.keys(srv.env ?? {}).sort(),
      running: st.running,
      last_error: st.last_error,
      tool_count: st.tool_count,
    }
  })
  return NextResponse.json(out)
}
