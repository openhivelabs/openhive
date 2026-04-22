export interface PanelCacheRow {
  panel_id: string
  team_id: string
  data: unknown
  error: string | null
  fetched_at: number | null
  duration_ms: number | null
  shape_hash?: string
  shape_changed?: boolean
}

export interface PanelTemplate {
  id: string
  name: string
  description: string
  icon: string
  category: string
  panel: {
    type: string
    colSpan?: number
    rowSpan?: number
    props?: Record<string, unknown>
  }
  binding_skeleton: Record<string, unknown>
  ai_prompts: Record<string, unknown>
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status}: ${body}`)
  }
  return (await res.json()) as T
}

export async function fetchPanelData(blockId: string): Promise<PanelCacheRow> {
  return jsonOrThrow(await fetch(`/api/panels/${encodeURIComponent(blockId)}/data`))
}

export async function refreshPanel(blockId: string): Promise<PanelCacheRow> {
  return jsonOrThrow(
    await fetch(`/api/panels/${encodeURIComponent(blockId)}/refresh`, { method: 'POST' }),
  )
}

export async function fetchPanelTemplates(): Promise<PanelTemplate[]> {
  return jsonOrThrow(await fetch('/api/panel-templates'))
}

export interface PreviewResult {
  ok: boolean
  data?: unknown
  error?: string
}

export async function previewBinding(
  teamId: string,
  panelType: string,
  binding: Record<string, unknown>,
): Promise<PreviewResult> {
  return jsonOrThrow(
    await fetch('/api/panel-templates/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: teamId, panel_type: panelType, binding }),
    }),
  )
}

export interface BuildBindingResult {
  binding: Record<string, unknown>
  panel_type: string
}

export async function buildBinding(
  teamId: string,
  templateId: string,
  userGoal: string,
): Promise<BuildBindingResult> {
  return jsonOrThrow(
    await fetch('/api/panel-templates/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: teamId, template_id: templateId, user_goal: userGoal }),
    }),
  )
}

export interface ActionResult {
  ok: boolean
  result?: unknown
  rows_changed?: number
  detail?: string
}

export async function executePanelAction(
  panelId: string,
  actionId: string,
  teamId: string,
  values: Record<string, unknown>,
): Promise<ActionResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let res: Response
  try {
    res = await fetch(
      `/api/panels/${encodeURIComponent(panelId)}/actions/${encodeURIComponent(actionId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, values }),
        signal: controller.signal,
      },
    )
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let body: ActionResult = { ok: res.ok }
  if (text) {
    try {
      body = JSON.parse(text) as ActionResult
    } catch {
      body = { ok: res.ok, detail: text.slice(0, 300) }
    }
  }
  if (!res.ok) {
    throw new Error(body.detail ?? `action failed: ${res.status}`)
  }
  return body
}

/** Open an EventSource on the SSE stream for live block updates.
 *  Returns a cleanup function. */
export function streamPanel(
  blockId: string,
  onRow: (row: PanelCacheRow) => void,
  onError?: (e: Event) => void,
): () => void {
  const es = new EventSource(`/api/panels/${encodeURIComponent(blockId)}/stream`)
  es.onmessage = (e) => {
    try {
      onRow(JSON.parse(e.data) as PanelCacheRow)
    } catch {
      /* ignore malformed */
    }
  }
  if (onError) es.onerror = onError
  return () => es.close()
}
