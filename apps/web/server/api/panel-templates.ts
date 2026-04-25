import { resolveTeamSlugs } from '@/lib/server/companies'
import { listServers } from '@/lib/server/mcp/config'
import { getTools } from '@/lib/server/mcp/manager'
import { AI_BUILDER_SYSTEM_PROMPT } from '@/lib/server/panels/ai-prompt'
import { apply as applyMapper } from '@/lib/server/panels/mapper'
import { execute as executeSource } from '@/lib/server/panels/sources'
import { getTemplate, listTemplates } from '@/lib/server/panels/templates'
import { chatCompletion } from '@/lib/server/providers/copilot'
import { describeSchema } from '@/lib/server/team-data'
import { Hono } from 'hono'

export const panelTemplates = new Hono()

interface BuildBody {
  team_id?: string
  template_id?: string
  user_goal?: string
}

interface PreviewBody {
  team_id?: string
  panel_type?: string
  binding?: Record<string, unknown>
}

// GET /api/panel-templates
panelTemplates.get('/', (c) =>
  c.json(
    listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      category: t.category,
      panel: t.block,
      binding_skeleton: t.binding_skeleton,
      ai_prompts: t.ai_prompts,
    })),
  ),
)

// POST /api/panel-templates/build
panelTemplates.post('/build', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BuildBody
  if (typeof body.team_id !== 'string' || !body.team_id) {
    return c.json({ detail: 'team_id required' }, 400)
  }
  if (typeof body.template_id !== 'string' || !body.template_id) {
    return c.json({ detail: 'template_id required' }, 400)
  }
  if (typeof body.user_goal !== 'string') {
    return c.json({ detail: 'user_goal required' }, 400)
  }

  const tpl = getTemplate(body.template_id)
  if (!tpl) {
    return c.json({ detail: `unknown template ${JSON.stringify(body.template_id)}` }, 404)
  }
  const resolved = resolveTeamSlugs(body.team_id)
  if (!resolved) {
    return c.json({ detail: 'team not found' }, 404)
  }

  const mcpLines: string[] = []
  for (const name of Object.keys(listServers())) {
    try {
      const tools = await getTools(name)
      const names = tools
        .slice(0, 30)
        .map((t) => t.name)
        .join(', ')
      mcpLines.push(names ? `  - ${name}: ${names}` : `  - ${name}: (no tools)`)
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc)
      mcpLines.push(`  - ${name}: (unavailable: ${message})`)
    }
  }

  let schema: ReturnType<typeof describeSchema>
  try {
    schema = describeSchema(resolved.companySlug, { teamId: body.team_id })
  } catch {
    schema = { tables: [], recent_migrations: [] }
  }
  const tdLines = (schema.tables ?? []).map(
    (t) => `  - ${t.name}(${t.columns.map((col) => `${col.name}:${col.type ?? ''}`).join(', ')})`,
  )

  const prompt = `PANEL TEMPLATE:
id: ${tpl.id}
name: ${tpl.name}
block_type: ${String(tpl.block.type ?? '')}
description: ${tpl.description}
binding_skeleton: ${JSON.stringify(tpl.binding_skeleton)}

AVAILABLE MCP SERVERS (with tool names):
${mcpLines.length > 0 ? mcpLines.join('\n') : '  (none connected)'}

TEAM DATA TABLES:
${tdLines.length > 0 ? tdLines.join('\n') : '  (no tables)'}`

  let text: string
  try {
    text = await chatCompletion({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: AI_BUILDER_SYSTEM_PROMPT },
        { role: 'user', content: `${prompt}\n\nUSER GOAL: ${body.user_goal}` },
      ],
      temperature: 0.2,
    })
  } catch (exc) {
    return c.json(
      {
        detail: `AI builder call failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      },
      502,
    )
  }
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) {
    return c.json({ detail: `AI builder did not return JSON. Got: ${text.slice(0, 300)}` }, 502)
  }
  let binding: Record<string, unknown>
  try {
    binding = JSON.parse(match[0]) as Record<string, unknown>
  } catch (exc) {
    return c.json(
      {
        detail: `AI builder JSON parse failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      },
      502,
    )
  }
  return c.json({ binding, panel_type: tpl.block.type })
})

// POST /api/panel-templates/preview
panelTemplates.post('/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as PreviewBody
  if (typeof body.team_id !== 'string' || !body.team_id) {
    return c.json({ detail: 'team_id required' }, 400)
  }
  if (typeof body.panel_type !== 'string' || !body.panel_type) {
    return c.json({ detail: 'panel_type required' }, 400)
  }
  if (!body.binding || typeof body.binding !== 'object') {
    return c.json({ detail: 'binding required' }, 400)
  }
  const resolved = resolveTeamSlugs(body.team_id)
  if (!resolved) {
    return c.json({ detail: 'team not found' }, 404)
  }
  const ctx = {
    companySlug: resolved.companySlug,
    teamSlug: resolved.teamSlug,
    teamId: body.team_id,
  }
  try {
    const raw = await executeSource(body.binding.source ?? {}, ctx)
    const shaped = applyMapper(
      raw,
      (body.binding.map as Record<string, unknown> | undefined) ?? {},
      body.panel_type,
    )
    return c.json({ ok: true, data: shaped })
  } catch (exc) {
    const name = exc instanceof Error ? exc.name : 'Error'
    const message = exc instanceof Error ? exc.message : String(exc)
    return c.json({ ok: false, error: `${name}: ${message}` })
  }
})
