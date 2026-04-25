import type { PanelBinding } from '@/lib/api/dashboards'
import { listServers } from '@/lib/server/mcp/config'
import { callTool, getTools } from '@/lib/server/mcp/manager'
import { chatCompletion } from '@/lib/server/providers/copilot'
import type { describeSchema } from '@/lib/server/team-data'
import { AI_BUILDER_SYSTEM_PROMPT } from './ai-prompt'

type Schema = ReturnType<typeof describeSchema>

interface AiBindInput {
  panel: Record<string, unknown>
  description?: string
  schema: Schema
  userIntent: string | null
}

export async function aiBindPanel({
  panel,
  description,
  schema,
  userIntent,
}: AiBindInput): Promise<PanelBinding> {
  const tdLines = (schema.tables ?? []).map(
    (t) =>
      `  - ${t.name}(${t.columns.map((col) => `${col.name}:${col.type ?? ''}`).join(', ')})`,
  )

  // Send each tool's name + description + input schema. Without the schema
  // the AI guesses argument names (e.g. `project` instead of `project_id`)
  // and the call returns empty / errors. Cap at 20 tools per server so the
  // prompt doesn't explode on servers exposing 100+ tools.
  //
  // ALSO eagerly call each server's discovery tools (list_*/search_* with no
  // required args) so the AI sees concrete name→ID pairs in its prompt. This
  // is the only way one-shot binding can resolve "curio" → UUID without a
  // round-trip — otherwise the AI just stops at list_projects and the user
  // has to follow up. Capped to 3 discovery tools per server, 5s budget.
  const mcpLines: string[] = []
  const idLines: string[] = []
  for (const name of Object.keys(listServers())) {
    try {
      const tools = await getTools(name)
      if (tools.length === 0) {
        mcpLines.push(`  ${name}: (no tools)`)
        continue
      }
      mcpLines.push(`  ${name}:`)
      for (const t of tools.slice(0, 20)) {
        const desc = (t.description ?? '').replace(/\s+/g, ' ').slice(0, 200)
        const schema = JSON.stringify(t.inputSchema ?? {}).slice(0, 600)
        mcpLines.push(`    - ${t.name}: ${desc}`)
        mcpLines.push(`      input_schema: ${schema}`)
      }
      const discoveryTools = tools
        .filter((t) => /^(list_|search_)/.test(t.name) && !hasRequiredArgs(t.inputSchema))
        .slice(0, 3)
      const pairs = await Promise.all(
        discoveryTools.map(async (t) => {
          try {
            const text = await callTool(name, t.name, {})
            return summarizeDiscovery(t.name, text)
          } catch {
            return ''
          }
        }),
      )
      const collected = pairs.filter((s) => s.length > 0)
      if (collected.length > 0) {
        idLines.push(`  ${name}:`)
        for (const block of collected) idLines.push(block)
      }
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc)
      mcpLines.push(`  ${name}: (unavailable: ${message})`)
    }
  }

  const goal = userIntent && userIntent.trim().length > 0
    ? userIntent.trim()
    : '(no specific request — pick a reasonable default for this panel given the schema)'

  const prompt = `PANEL FRAME:
type: ${String(panel.type ?? '')}
title: ${String(panel.title ?? '')}
description: ${description ?? ''}
current_binding: ${JSON.stringify(panel.binding ?? null)}

AVAILABLE MCP SERVERS (with tool names):
${mcpLines.length > 0 ? mcpLines.join('\n') : '  (none connected)'}
${idLines.length > 0 ? `\nKNOWN IDENTIFIERS (resolved by calling discovery tools — use these IDs directly, do NOT pass the human-readable name as an opaque ID):\n${idLines.join('\n')}\n` : ''}
TEAM DATA TABLES:
${tdLines.length > 0 ? tdLines.join('\n') : '  (no tables)'}

USER GOAL: ${goal}`

  const text = await chatCompletion({
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: AI_BUILDER_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  })

  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) {
    throw new Error(`AI binder did not return JSON. Got: ${text.slice(0, 300)}`)
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>
  } catch (exc) {
    throw new Error(
      `AI binder JSON parse failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    )
  }
  if (
    typeof parsed.source !== 'object' ||
    parsed.source === null ||
    typeof parsed.map !== 'object' ||
    parsed.map === null
  ) {
    throw new Error('AI binder output missing source/map')
  }
  return parsed as unknown as PanelBinding
}

function hasRequiredArgs(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || typeof schema !== 'object') return false
  const required = (schema as { required?: unknown }).required
  return Array.isArray(required) && required.length > 0
}

/** Best-effort summary of a discovery-tool response: pull `id`/`uuid`/`ref`
 *  + `name`/`title`/`slug` pairs out of any array-shaped result so the AI
 *  can map a human name to the opaque identifier. Caps at 20 entries to
 *  keep the prompt small. Returns '' if nothing useful was found. */
function summarizeDiscovery(toolName: string, text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return ''
  }
  // Unwrap one level if the payload is { items: [...] } / { projects: [...] }
  // — common MCP shape.
  let items: unknown[] = []
  if (Array.isArray(parsed)) {
    items = parsed
  } else if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        items = v
        break
      }
    }
  }
  if (items.length === 0) return ''
  const ID_KEYS = ['id', 'uuid', 'ref', 'slug', 'key']
  const NAME_KEYS = ['name', 'title', 'label', 'display_name', 'slug']
  const lines: string[] = []
  for (const it of items.slice(0, 20)) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    let id: string | null = null
    let name: string | null = null
    for (const k of ID_KEYS) {
      const v = o[k]
      if (typeof v === 'string') {
        id = v
        break
      }
    }
    for (const k of NAME_KEYS) {
      if (k === id) continue
      const v = o[k]
      if (typeof v === 'string' && v !== id) {
        name = v
        break
      }
    }
    if (id && name) lines.push(`      - ${name} → ${id}`)
    else if (id) lines.push(`      - ${id}`)
  }
  if (lines.length === 0) return ''
  return `    ${toolName}:\n${lines.join('\n')}`
}
