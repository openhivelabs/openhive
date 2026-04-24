/**
 * Recipe library — pre-authored PanelSpec templates with parameter slots.
 *
 * Recipes exist for two reasons:
 *   1. Grounding: AI's first move when asked "add a Slack panel" is to pick a
 *      recipe, not hand-roll a source spec. Catches 80% of real-world asks.
 *   2. UX: shows up in the "+ 패널" picker as a named, icon'd option so
 *      non-technical users can install without chatting.
 *
 * Storage:
 *   - Bundled recipes ship in `packages/recipes/*.yaml` (repo) and are always
 *     readable.
 *   - User overrides live in `~/.openhive/recipes/*.yaml` and take precedence
 *     when the id matches (so users can tune a bundled recipe without
 *     forking the repo).
 *
 * Recipe schema (YAML):
 *   id: slack-recent
 *   label: "Slack 최근 메시지"
 *   icon: ChatCircleText              # Phosphor icon name
 *   category: email | calendar | messaging | code | sales | data | weather
 *   requires:                          # optional gate — hide if unmet
 *     mcp_server: slack                # OR
 *     auth_ref: openweather            # (api_key kind)
 *   panel:                             # literal PanelSpec template
 *     type: kpi
 *     title: "{{label}}"
 *     binding:
 *       source: {kind: mcp, config: {server: slack, tool: list_messages, args: {}}}
 *       map:    {aggregate: first, value: "$.count"}
 *       refresh_seconds: 300
 *   params:                            # optional user-fillable slots
 *     - name: city
 *       label: "도시"
 *       type: text
 *       default: "Seoul"
 *       injects:                       # where in `panel` to substitute
 *         - path: "binding.source.config.url"
 *           template: "https://api.openweathermap.org/data/2.5/weather?q={{city}}"
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { dataDir, packagesRoot } from './paths'

export interface RecipeParam {
  name: string
  label: string
  type: 'text' | 'number' | 'select'
  default?: unknown
  options?: string[]
  required?: boolean
  injects?: { path: string; template: string }[]
}

export interface RecipeRequires {
  mcp_server?: string
  auth_ref?: string
}

export interface Recipe {
  id: string
  label: string
  icon?: string
  category?: string
  description?: string
  requires?: RecipeRequires
  panel: Record<string, unknown>
  params?: RecipeParam[]
  /** Optional DDL (or seed INSERTs) run once against the team's data.db when
   *  this recipe is installed. Typically `CREATE TABLE IF NOT EXISTS …` so
   *  the recipe brings its own schema instead of breaking when the table is
   *  missing. Multi-statement allowed here (splits on `;`). */
  setup_sql?: string
}

function bundledDir(): string {
  return path.join(packagesRoot(), 'recipes')
}

function userDir(): string {
  return path.join(dataDir(), 'recipes')
}

function readYamlFile(p: string): Recipe | null {
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = yaml.load(raw) as Partial<Recipe> | null
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.id !== 'string' || typeof parsed.label !== 'string' || !parsed.panel) {
      return null
    }
    return parsed as Recipe
  } catch {
    return null
  }
}

function readDir(dir: string): Recipe[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => readYamlFile(path.join(dir, f)))
    .filter((r): r is Recipe => r !== null)
}

export function listRecipes(): Recipe[] {
  const bundled = readDir(bundledDir())
  const user = readDir(userDir())
  // User overrides take precedence on id collision.
  const byId = new Map<string, Recipe>()
  for (const r of bundled) byId.set(r.id, r)
  for (const r of user) byId.set(r.id, r)
  return Array.from(byId.values()).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
}

export function getRecipe(id: string): Recipe | null {
  return listRecipes().find((r) => r.id === id) ?? null
}

/**
 * Instantiate a recipe with user-supplied param values. Returns the concrete
 * PanelSpec ready to persist into dashboard.yaml. Missing required params
 * throw. Values are substituted via simple `{{name}}` placeholder replacement
 * at the paths declared in `param.injects`.
 */
export function instantiateRecipe(
  recipe: Recipe,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const panel = JSON.parse(JSON.stringify(recipe.panel)) as Record<string, unknown>
  const resolved: Record<string, unknown> = {}
  for (const p of recipe.params ?? []) {
    const v = values[p.name] ?? p.default
    if (p.required && (v === undefined || v === null || v === '')) {
      throw new Error(`recipe "${recipe.id}" missing required param "${p.name}"`)
    }
    resolved[p.name] = v
    if (!p.injects) continue
    for (const inj of p.injects) {
      const rendered = inj.template.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
        String(resolved[k] ?? values[k] ?? ''),
      )
      setByPath(panel, inj.path, rendered)
    }
  }
  return panel
}

function setByPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string
    const next = cur[key]
    if (next === undefined || typeof next !== 'object' || next === null) {
      const obj: Record<string, unknown> = {}
      cur[key] = obj
      cur = obj
    } else {
      cur = next as Record<string, unknown>
    }
  }
  cur[parts[parts.length - 1] as string] = value
}
