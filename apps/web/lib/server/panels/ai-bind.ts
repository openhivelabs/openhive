import type { PanelBinding } from '@/lib/api/dashboards'
import { listServers } from '@/lib/server/mcp/config'
import { getTools } from '@/lib/server/mcp/manager'
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
