import { NextResponse } from 'next/server'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { listServers } from '@/lib/server/mcp/config'
import { getTools } from '@/lib/server/mcp/manager'
import { chatCompletion } from '@/lib/server/providers/copilot'
import { getTemplate } from '@/lib/server/panels/templates'
import { describeSchema } from '@/lib/server/team-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  team_id?: string
  template_id?: string
  user_goal?: string
}

const AI_BUILDER_SYSTEM_PROMPT = `You configure data bindings for OpenHive dashboard panels.

INPUT: a panel-template skeleton (which block type + a binding_skeleton) + the
user's goal in plain language + the set of data sources available to this team
(team data DB tables, connected MCP servers with their tool lists).

OUTPUT: strict JSON for the \`binding\` field. Schema:

    {
      "source": {
        "kind":   "mcp" | "team_data" | "http" | "file" | "static",
        "config": { ...kind-specific... }
      },
      "map": {
        "rows":            "<JSONPath into the response, e.g. $.items[*]>",
        "group_by":        "<dotted field path for kanban/chart>",
        "title":           "<dotted field path for row title>",
        "value":           "<dotted field path for row numeric value>",
        "columns":         [ "<field>", ... ],
        "filter":          "<field op literal>",
        "aggregate":       "count|sum|avg|min|max|first",
        "aggregate_field": "<dotted field path>",
        "on_click":        { "kind": "detail" }
                        | { "kind": "open_url", "url_field": "<dotted path in row>" }
      },
      "refresh_seconds": <int, 0 = manual only, 30..3600 recommended>
    }

Config shapes per source kind:
  mcp:        { "server": "<name>", "tool": "<tool>", "args": { ... } }
  team_data:  { "sql": "SELECT ... (read-only only)" }
  http:       { "url": "...", "method": "GET|POST", "headers": {}, "body": {...} }
  file:       { "path": "relative/to/data_dir" }
  static:     { "value": <any> }

RULES:
- Prefer \`team_data\` when the data is already in the team's SQLite.
- Prefer \`mcp\` when it lives externally and the right server is connected.
- Keep SQL tight — name columns the panel will consume, avoid SELECT *.
- Never invent tools or tables that aren't listed in the context.
- refresh_seconds: 60 normal, 300 heavy, 30 fast-changing.
- For team_data sources, the query result arrives as { columns, rows } — use
  \`map.rows: "$.rows[*]"\` (NOT "$[*]") unless you pass it through transforms.
- For a kpi block when SQL already aggregates (COUNT/SUM/AVG in the query),
  use \`map.aggregate: "first"\` with \`aggregate_field\` naming the single column.
  Otherwise the mapper will count the number of rows instead of reading the value.
- \`on_click\` applies only to table / kanban / list panels (row/card/item = Cell).
  Default to \`{"kind": "detail"}\` so users can inspect the full row. Use
  \`{"kind": "open_url", "url_field": "<path>"}\` ONLY when a row has a clearly
  named URL-ish column (e.g. \`url\`, \`link\`, \`permalink\`, \`html_url\`). Never
  fabricate a URL field. Omit \`on_click\` entirely for kpi / chart.
- Respond with ONLY the JSON object. No prose, no markdown fences.`

export async function POST(req: Request) {
  const body = (await req.json()) as Body
  if (typeof body.team_id !== 'string' || !body.team_id) {
    return NextResponse.json({ detail: 'team_id required' }, { status: 400 })
  }
  if (typeof body.template_id !== 'string' || !body.template_id) {
    return NextResponse.json({ detail: 'template_id required' }, { status: 400 })
  }
  if (typeof body.user_goal !== 'string') {
    return NextResponse.json({ detail: 'user_goal required' }, { status: 400 })
  }

  const tpl = getTemplate(body.template_id)
  if (!tpl) {
    return NextResponse.json(
      { detail: `unknown template ${JSON.stringify(body.template_id)}` },
      { status: 404 },
    )
  }
  const resolved = resolveTeamSlugs(body.team_id)
  if (!resolved) {
    return NextResponse.json({ detail: 'team not found' }, { status: 404 })
  }

  const mcpLines: string[] = []
  for (const name of Object.keys(listServers())) {
    try {
      const tools = await getTools(name)
      const names = tools.slice(0, 30).map((t) => t.name).join(', ')
      mcpLines.push(names ? `  - ${name}: ${names}` : `  - ${name}: (no tools)`)
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc)
      mcpLines.push(`  - ${name}: (unavailable: ${message})`)
    }
  }

  let schema: ReturnType<typeof describeSchema>
  try {
    schema = describeSchema(resolved.companySlug, resolved.teamSlug)
  } catch {
    schema = { tables: [], recent_migrations: [] }
  }
  const tdLines = (schema.tables ?? []).map(
    (t) =>
      `  - ${t.name}(${t.columns.map((c) => `${c.name}:${c.type ?? ''}`).join(', ')})`,
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
    return NextResponse.json(
      {
        detail: `AI builder call failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      },
      { status: 502 },
    )
  }
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) {
    return NextResponse.json(
      {
        detail: `AI builder did not return JSON. Got: ${text.slice(0, 300)}`,
      },
      { status: 502 },
    )
  }
  let binding: Record<string, unknown>
  try {
    binding = JSON.parse(match[0]) as Record<string, unknown>
  } catch (exc) {
    return NextResponse.json(
      {
        detail: `AI builder JSON parse failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      },
      { status: 502 },
    )
  }
  return NextResponse.json({ binding, panel_type: tpl.block.type })
}
