/**
 * Tool primitives. A Tool is metadata + an async handler.
 * Ports apps/server/openhive/tools/base.py + formats.py.
 */

import type { ToolSpec } from '../providers/types'

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
  /** UI hint shown when the tool runs (e.g. "Delegating to Researcher…"). */
  hint?: string | null
  /**
   * Optional marker indicating this tool wraps a skill invocation. The engine
   * uses it to emit `skill.queued` + `skill.started` events so the UI can
   * show queue state when the global Python concurrency limiter is
   * saturated. Non-skill tools leave this undefined.
   *
   * When present, the engine calls `runWithHooks` (not `handler`) and wires
   * `onQueued` / `onStarted` hooks so it can yield lifecycle events at the
   * right moments. `handler` must still be defined as a fallback / type
   * placeholder; it should just throw if called directly.
   */
  skill?: {
    name: string
    runWithHooks: (
      args: Record<string, unknown>,
      hooks: { onQueued: () => void; onStarted: () => void },
    ) => Promise<unknown>
  } | null
}

export interface ToolCallSpec {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  call_id: string
  name: string
  content: string
  is_error?: boolean
}

export function toolsToOpenAI(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}
