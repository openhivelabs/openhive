/**
 * AI Composer — server-side brain for the dashboard chat dock.
 *
 * Given a user request + team context, the composer produces one of four
 * outcomes:
 *   - create:  a new PanelSpec appended to dashboard.yaml
 *   - edit:    partial patch to an existing panel by id
 *   - delete:  remove a panel by id
 *   - ask:     clarifying question back to the user (no side effects)
 *
 * Grounding: the system prompt embeds the *actual* catalog (MCP servers +
 * tools, team tables + schema, team files, recipes, credentials). The model
 * picks from the catalog only; if nothing fits, it returns `ask` rather than
 * hallucinating a source.
 *
 * Recipe-first: the model is steered to instantiate a recipe whenever one
 * matches, then only fall back to raw source specs for custom asks.
 *
 * No streaming in v1 — one request, one JSON response. Streaming is a UX
 * enhancement we can layer on once the round-trip behaves.
 */

import { extractJson } from '../ai-generators/common'
import { resolveTeamSlugs } from '../companies'
import { listCredentials } from '../credentials'
import { loadDashboard, saveDashboard } from '../dashboards'
import { listMcpCatalog } from '../panels/mcp-catalog'
import { listTeamFiles } from '../panels/sources'
import { chatCompletion } from '../providers/copilot'
import { type Recipe, instantiateRecipe, listRecipes } from '../recipes'
import { describeSchema, runExec } from '../team-data'

export type ComposerAction =
  | { action: 'create'; panel: Record<string, unknown>; message?: string }
  | { action: 'edit'; panel_id: string; patch: Record<string, unknown>; message?: string }
  | { action: 'delete'; panel_id: string; message?: string }
  | { action: 'ask'; message: string }
  | { action: 'recipe'; recipe_id: string; params?: Record<string, unknown>; title?: string; message?: string }

export interface ComposerResult {
  assistant_message: string
  applied: {
    kind: 'created' | 'edited' | 'deleted' | 'none'
    panel_id?: string
  }
}

// Panel types the AI is allowed to emit. Frontend renderers use this exact set.
const PANEL_TYPES = ['kpi', 'table', 'kanban', 'chart', 'list', 'note', 'activity'] as const

// ---------------- system prompt ----------------

function catalogSummary(params: {
  recipes: Recipe[]
  mcpServers: { id: string; label: string; connected: boolean; tools: { name: string; mutates: boolean }[] }[]
  teamTables: { name: string; columns: { name: string; type: string }[]; row_count: number }[]
  teamFiles: string[]
  credentials: { ref_id: string; kind: string; label?: string }[]
}): string {
  const lines: string[] = []
  lines.push('RECIPES (prefer these — each is a ready-made PanelSpec):')
  for (const r of params.recipes) {
    lines.push(
      `  - ${r.id} · ${r.label}${r.description ? ` — ${r.description}` : ''}`,
    )
  }
  lines.push('')
  lines.push('MCP SERVERS (connected tools you can call directly):')
  for (const s of params.mcpServers) {
    const flag = s.connected ? '✓' : '✗'
    lines.push(`  [${flag}] ${s.id} (${s.label})`)
    for (const t of s.tools.slice(0, 12)) {
      lines.push(`      · ${t.name}${t.mutates ? ' [MUTATES]' : ''}`)
    }
    if (s.tools.length > 12) lines.push(`      · …+${s.tools.length - 12} more tools`)
  }
  if (params.mcpServers.length === 0) lines.push('  (none configured)')
  lines.push('')
  lines.push('TEAM DATA TABLES (local SQLite):')
  for (const t of params.teamTables) {
    const cols = t.columns.map((c) => `${c.name}:${c.type}`).join(', ')
    lines.push(`  - ${t.name} (${t.row_count} rows) — ${cols}`)
  }
  if (params.teamTables.length === 0) lines.push('  (none — user data.db is empty)')
  lines.push('')
  lines.push('TEAM FILES:')
  for (const f of params.teamFiles.slice(0, 20)) lines.push(`  - ${f}`)
  if (params.teamFiles.length === 0) lines.push('  (none)')
  lines.push('')
  lines.push('CREDENTIALS (auth_ref values you can reference — never see raw keys):')
  for (const c of params.credentials) {
    lines.push(`  - ${c.ref_id} [${c.kind}]${c.label ? ` · ${c.label}` : ''}`)
  }
  if (params.credentials.length === 0) lines.push('  (none)')
  return lines.join('\n')
}

function systemPrompt(
  catalog: string,
  currentPanels: { id: string; type: string; title: string }[],
): string {
  const panelsList = currentPanels.length
    ? currentPanels.map((p) => `  - ${p.id} · ${p.type} · "${p.title}"`).join('\n')
    : '  (empty)'
  return `You are the dashboard composer for OpenHive. The user describes what they
want; you return EXACTLY ONE JSON object that represents one of these actions:

{"action":"recipe",  "recipe_id":"<id>", "params":{...}, "title":"<optional override>"}
{"action":"create",  "panel": <full PanelSpec>}
{"action":"edit",    "panel_id":"<id>", "patch": <partial PanelSpec>}
{"action":"delete",  "panel_id":"<id>"}
{"action":"ask",     "message":"<a clarifying question for the user in Korean>"}

Always include a short assistant \`message\` field (1 sentence, Korean) except
for \`ask\` where \`message\` IS the reply to the user.

HARD RULES
1. Recipe-first: if any recipe in the catalog matches the user's intent,
   use {"action":"recipe","recipe_id":"<id>",...}. Do not hand-roll a source
   when a recipe exists.
2. Never invent sources: only reference MCP servers, tools, tables, files, and
   credentials that appear in the CATALOG below. If nothing fits, respond
   with {"action":"ask","message":"..."} and explain what's missing.
3. Panel types are EXACTLY: ${PANEL_TYPES.join(', ')}.
4. For team_data SELECTs, use columns that actually exist in the listed tables.
   Always add \`LIMIT 100\` or similar. Prefer \`WHERE deleted_at IS NULL\` if
   the table has that column.
5. For http sources that need auth, set \`auth_ref\` to one of the credential
   ref_ids from the catalog. Never embed raw keys.
6. For destructive actions (delete row, send email, …) include
   \`confirm: true\` and for external irreversible writes also
   \`irreversible: true\`.

CURRENT PANELS ON THIS DASHBOARD:
${panelsList}

CATALOG:
${catalog}

OUTPUT
Return ONLY the JSON object. No prose, no markdown fences, no backticks.`
}

// ---------------- public API ----------------

export async function composeOnce(input: {
  teamId: string
  userMessage: string
}): Promise<ComposerResult> {
  const slugs = resolveTeamSlugs(input.teamId)
  if (!slugs) throw new Error('team not found')

  // Build grounding catalog.
  const [mcp, recipes] = await Promise.all([listMcpCatalog(), Promise.resolve(listRecipes())])
  let teamTables: {
    name: string
    columns: { name: string; type: string }[]
    row_count: number
  }[] = []
  try {
    teamTables = describeSchema(slugs.companySlug, { teamId: input.teamId }).tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      row_count: t.row_count,
    }))
  } catch {
    /* empty db is fine */
  }
  const teamFiles = listTeamFiles(slugs.companySlug, slugs.teamSlug)
  const creds = listCredentials().map((c) => ({
    ref_id: c.ref_id,
    kind: c.kind,
    label: c.label,
  }))

  const layout = loadDashboard(slugs.companySlug, slugs.teamSlug) ?? { blocks: [] }
  const blocks = Array.isArray(layout.blocks) ? (layout.blocks as Record<string, unknown>[]) : []
  const currentPanels = blocks.map((b) => ({
    id: String(b.id ?? ''),
    type: String(b.type ?? ''),
    title: String(b.title ?? ''),
  }))

  const catalog = catalogSummary({
    recipes,
    mcpServers: mcp.map((s) => ({
      id: s.id,
      label: s.label,
      connected: s.connected,
      tools: s.tools.map((t) => ({ name: t.name, mutates: t.mutates })),
    })),
    teamTables,
    teamFiles,
    credentials: creds,
  })

  const raw = await chatCompletion({
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: systemPrompt(catalog, currentPanels) },
      { role: 'user', content: input.userMessage },
    ],
    temperature: 0.2,
  })

  let parsed: Record<string, unknown>
  try {
    parsed = extractJson(raw)
  } catch (e) {
    return {
      assistant_message:
        '응답을 해석하지 못했어요. 다시 요청해주시거나 더 구체적으로 설명해주시겠어요?',
      applied: { kind: 'none' },
    }
  }

  const action = String(parsed.action ?? '').trim()
  const assistantMessage = typeof parsed.message === 'string' ? parsed.message : ''

  switch (action) {
    case 'ask':
      return {
        assistant_message:
          assistantMessage || '무엇을 만들까요? 조금 더 자세히 알려주세요.',
        applied: { kind: 'none' },
      }

    case 'recipe': {
      const recipeId = String(parsed.recipe_id ?? '')
      const recipe = recipes.find((r) => r.id === recipeId)
      if (!recipe) {
        return {
          assistant_message: `'${recipeId}' 레시피를 찾지 못했어요.`,
          applied: { kind: 'none' },
        }
      }
      const params = (parsed.params && typeof parsed.params === 'object'
        ? parsed.params
        : {}) as Record<string, unknown>
      let panel: Record<string, unknown>
      try {
        panel = instantiateRecipe(recipe, params)
      } catch (e) {
        return {
          assistant_message: `레시피 적용 실패: ${e instanceof Error ? e.message : String(e)}`,
          applied: { kind: 'none' },
        }
      }
      const title =
        typeof parsed.title === 'string' && parsed.title ? parsed.title : recipe.label
      panel.id = newPanelId()
      if (title) panel.title = title
      if (recipe.setup_sql) {
        try {
          for (const stmt of recipe.setup_sql
            .split(/;\s*\n/)
            .map((s) => s.trim())
            .filter(Boolean)) {
            runExec(slugs.companySlug, stmt, {
              source: `recipe:${recipe.id}`,
              note: 'setup_sql',
              teamId: input.teamId,
            })
          }
        } catch (e) {
          return {
            assistant_message: `테이블 초기화 실패: ${e instanceof Error ? e.message : String(e)}`,
            applied: { kind: 'none' },
          }
        }
      }
      blocks.push(panel)
      saveDashboard(slugs.companySlug, slugs.teamSlug, { ...layout, blocks })
      return {
        assistant_message: assistantMessage || `${recipe.label} 패널을 추가했어요.`,
        applied: { kind: 'created', panel_id: String(panel.id) },
      }
    }

    case 'create': {
      const panel = parsed.panel as Record<string, unknown> | undefined
      if (!panel || typeof panel !== 'object') {
        return {
          assistant_message: '패널 정의가 비어있어서 추가하지 못했어요.',
          applied: { kind: 'none' },
        }
      }
      if (!PANEL_TYPES.includes(String(panel.type) as (typeof PANEL_TYPES)[number])) {
        return {
          assistant_message: `지원하지 않는 패널 타입(${panel.type})이에요.`,
          applied: { kind: 'none' },
        }
      }
      if (!panel.id || typeof panel.id !== 'string') panel.id = newPanelId()
      blocks.push(panel)
      saveDashboard(slugs.companySlug, slugs.teamSlug, { ...layout, blocks })
      return {
        assistant_message: assistantMessage || '패널을 추가했어요.',
        applied: { kind: 'created', panel_id: String(panel.id) },
      }
    }

    case 'edit': {
      const panelId = String(parsed.panel_id ?? '')
      const patch = (parsed.patch && typeof parsed.patch === 'object'
        ? parsed.patch
        : {}) as Record<string, unknown>
      const idx = blocks.findIndex((b) => b && b.id === panelId)
      if (idx < 0) {
        return {
          assistant_message: `'${panelId}' 패널을 찾지 못했어요.`,
          applied: { kind: 'none' },
        }
      }
      blocks[idx] = deepMerge(blocks[idx] as Record<string, unknown>, patch)
      saveDashboard(slugs.companySlug, slugs.teamSlug, { ...layout, blocks })
      return {
        assistant_message: assistantMessage || '패널을 수정했어요.',
        applied: { kind: 'edited', panel_id: panelId },
      }
    }

    case 'delete': {
      const panelId = String(parsed.panel_id ?? '')
      const next = blocks.filter((b) => b && b.id !== panelId)
      if (next.length === blocks.length) {
        return {
          assistant_message: `'${panelId}' 패널을 찾지 못했어요.`,
          applied: { kind: 'none' },
        }
      }
      saveDashboard(slugs.companySlug, slugs.teamSlug, { ...layout, blocks: next })
      return {
        assistant_message: assistantMessage || '패널을 삭제했어요.',
        applied: { kind: 'deleted', panel_id: panelId },
      }
    }

    default:
      return {
        assistant_message: `알 수 없는 액션(${action})입니다.`,
        applied: { kind: 'none' },
      }
  }
}

function newPanelId(): string {
  return `p-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}
