/**
 * MCP catalog — flattens all configured MCP servers + their tools into a
 * single shape the AI composer can ground on. Includes a best-effort
 * `mutates` flag so the composer knows which tools are side-effecting.
 *
 * Heuristic: a tool mutates if:
 *   - annotations.destructive / annotations.readOnly are set in the tool
 *     descriptor (MCP 1.0 optional convention), OR
 *   - tool name starts with a verb commonly associated with writes:
 *     create/add/insert/send/post/update/patch/delete/remove/set/write/
 *     mark/archive/close/reopen/assign/merge
 *
 * False positives are preferred over false negatives: we'd rather ask the
 * user to confirm a read than silently send an email.
 */

import { listServers } from '../mcp/config'
import { getTools, statusSnapshot } from '../mcp/manager'

export interface CatalogTool {
  name: string
  description: string
  mutates: boolean
  input_schema: Record<string, unknown>
}

export interface CatalogServer {
  id: string
  label: string
  connected: boolean
  tools: CatalogTool[]
  error?: string | null
}

const MUTATION_VERBS = [
  'create',
  'add',
  'insert',
  'send',
  'post',
  'update',
  'patch',
  'delete',
  'remove',
  'set',
  'write',
  'mark',
  'archive',
  'close',
  'reopen',
  'assign',
  'merge',
  'schedule',
  'publish',
  'upload',
]

function inferMutates(
  name: string,
  description: string,
  schema: Record<string, unknown>,
): boolean {
  const annotations = schema?.annotations as Record<string, unknown> | undefined
  if (annotations) {
    if (annotations.destructiveHint === true) return true
    if (annotations.readOnlyHint === true) return false
  }
  const lower = name.toLowerCase()
  // Match word-boundary verbs anywhere in the tool name (e.g. `slack_send_message`).
  for (const verb of MUTATION_VERBS) {
    const re = new RegExp(`(^|[_\\W])${verb}([_\\W]|$)`)
    if (re.test(lower)) return true
  }
  const desc = description.toLowerCase()
  if (/\b(create|send|delete|remove|update|modify)\b/.test(desc)) return true
  return false
}

export async function listMcpCatalog(): Promise<CatalogServer[]> {
  const servers = listServers()
  const status = statusSnapshot()
  const out: CatalogServer[] = []
  for (const [id, cfg] of Object.entries(servers)) {
    const label = String(cfg.label ?? id)
    const connected = status[id]?.connected === true
    let tools: CatalogTool[] = []
    let error: string | null = null
    try {
      const fetched = await getTools(id)
      tools = fetched.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema ?? {},
        mutates: inferMutates(t.name, t.description, t.inputSchema ?? {}),
      }))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    out.push({ id, label, connected, tools, error })
  }
  return out
}
