import {
  type ServerConfig,
  deleteServer,
  getServer,
  listServers,
  upsertServer,
} from '@/lib/server/mcp/config'
import { getTools, restart, statusSnapshot, testConnection } from '@/lib/server/mcp/manager'
import { getPreset, listPresets, materialise } from '@/lib/server/mcp/presets'
import { Hono } from 'hono'

export const mcp = new Hono()

// GET /api/mcp/presets
mcp.get('/presets', (c) =>
  c.json(
    listPresets().map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      brand: p.brand,
      icon_url: p.icon_url,
      description: p.description,
      coming_soon: p.coming_soon,
      inputs: p.inputs.map((i) => ({
        key: i.key,
        label: i.label,
        type: i.type,
        placeholder: i.placeholder,
        help_text: i.help_text,
        required: i.required,
      })),
    })),
  ),
)

// GET /api/mcp/servers
mcp.get('/servers', (c) => {
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
  return c.json(out)
})

interface UpsertBody {
  server?: Record<string, unknown>
}

// PUT /api/mcp/servers/:name
mcp.put('/servers/:name', async (c) => {
  const name = c.req.param('name')
  const body = (await c.req.json().catch(() => ({}))) as UpsertBody
  if (!body.server || typeof body.server !== 'object') {
    return c.json({ detail: 'server body required' }, 400)
  }
  try {
    upsertServer(name, body.server as Parameters<typeof upsertServer>[1])
  } catch (err) {
    return c.json({ detail: err instanceof Error ? err.message : String(err) }, 400)
  }
  await restart(name)
  return c.json({ ok: true, name })
})

// DELETE /api/mcp/servers/:name
mcp.delete('/servers/:name', async (c) => {
  const name = c.req.param('name')
  await restart(name)
  if (!deleteServer(name)) {
    return c.json({ detail: 'server not found' }, 404)
  }
  return c.json({ ok: true })
})

// POST /api/mcp/servers/:name/restart
mcp.post('/servers/:name/restart', async (c) => {
  const name = c.req.param('name')
  await restart(name)
  return c.json({ ok: true })
})

// POST /api/mcp/servers/:name/test
mcp.post('/servers/:name/test', async (c) => {
  const name = c.req.param('name')
  const server = getServer(name)
  if (!server) {
    return c.json({ detail: 'server not found' }, 404)
  }
  return c.json(await testConnection(server))
})

// GET /api/mcp/servers/:name/tools
mcp.get('/servers/:name/tools', async (c) => {
  const name = c.req.param('name')
  try {
    const tools = await getTools(name)
    return c.json({
      name,
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = msg.includes('not configured') ? 404 : 502
    return c.json({ detail: msg }, status)
  }
})

interface FromPresetBody {
  preset_id?: string
  name?: string
  inputs?: Record<string, string>
}

// POST /api/mcp/servers/from-preset
mcp.post('/servers/from-preset', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as FromPresetBody
  if (typeof body.preset_id !== 'string' || !body.preset_id) {
    return c.json({ detail: 'preset_id required' }, 400)
  }
  if (typeof body.name !== 'string' || !body.name) {
    return c.json({ detail: 'name required' }, 400)
  }
  const preset = getPreset(body.preset_id)
  if (!preset) {
    return c.json({ detail: `unknown preset ${JSON.stringify(body.preset_id)}` }, 404)
  }
  if (preset.coming_soon) {
    return c.json({ detail: 'this preset is coming soon — not yet available' }, 400)
  }
  const inputs = body.inputs ?? {}
  const missing = preset.inputs.filter((i) => i.required && !inputs[i.key]).map((i) => i.key)
  if (missing.length > 0) {
    return c.json({ detail: `missing inputs: ${JSON.stringify(missing)}` }, 400)
  }
  const server = materialise(preset, inputs)
  try {
    upsertServer(body.name, server)
  } catch (err) {
    return c.json({ detail: err instanceof Error ? err.message : String(err) }, 400)
  }
  await restart(body.name)
  return c.json({ ok: true, name: body.name })
})

interface TestBody {
  server?: Partial<ServerConfig> | null
  preset_id?: string | null
  inputs?: Record<string, string> | null
}

// POST /api/mcp/test
mcp.post('/test', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as TestBody
  let server: ServerConfig
  if (body.preset_id) {
    const preset = getPreset(body.preset_id)
    if (!preset) {
      return c.json({ detail: 'unknown preset' }, 404)
    }
    server = materialise(preset, body.inputs ?? {})
  } else if (body.server) {
    const raw = body.server
    if (!raw.command) {
      return c.json({ detail: 'server.command required' }, 400)
    }
    server = {
      command: String(raw.command),
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env:
        raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
          ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]))
          : {},
    }
  } else {
    return c.json({ detail: 'provide either preset_id+inputs or server' }, 400)
  }
  return c.json(await testConnection(server))
})
