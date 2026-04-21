/**
 * Agent persona loader.
 * Ports apps/server/openhive/agents/loader.py.
 *
 * A persona is the behavioural spec for one node on the org chart. Two
 * formats coexist:
 *   1. Single-file: `<name>.md` with optional YAML frontmatter.
 *   2. Directory: `<name>/AGENT.md` (required) + optional tools.yaml,
 *      knowledge/, examples/, behaviors/ subdirs (progressive disclosure
 *      — the agent reads them on demand via `read_agent_file`).
 *
 * Scan roots (later overrides earlier):
 *   - bundled:      <repo>/packages/agents/:name/AGENT.md or :name.md
 *   - company:      <company_dir>/agents/:name/AGENT.md or :name.md
 *   - user-global:  ~/.openhive/agents/:name/AGENT.md or :name.md
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { dataDir, packagesRoot } from '../paths'

export const MAX_LISTED_FILES = 60
export const MAX_READABLE_FILE_BYTES = 256 * 1024

export type PersonaKind = 'file' | 'dir'

export interface ToolsManifest {
  skills: string[]
  mcp_servers: string[]
  team_data_read: boolean
  team_data_write: boolean
  team_data_allowed_tables: string[]
  team_data_write_fields: string[]
  knowledge_exposure: 'summary' | 'full' | 'none'
  notes: string
}

function defaultToolsManifest(): ToolsManifest {
  return {
    skills: [],
    mcp_servers: [],
    team_data_read: true,
    team_data_write: false,
    team_data_allowed_tables: [],
    team_data_write_fields: [],
    knowledge_exposure: 'full',
    notes: '',
  }
}

export interface PersonaDef {
  name: string
  description: string
  kind: PersonaKind
  /** File (kind=file) or directory (kind=dir) path. */
  path: string
  body: string
  source: 'bundled' | 'user' | 'company' | 'inline'
  model: string | null
  /** Relative paths inside the directory (kind=dir only). */
  file_tree: string[]
  tools: ToolsManifest
  meta: Record<string, unknown>
}

function splitFrontmatter(
  text: string,
): { fm: Record<string, unknown> | null; body: string } {
  if (!text.startsWith('---')) return { fm: null, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { fm: null, body: text }
  const block = text.slice(3, end).replace(/^\n+/, '')
  let bodyStart = end + '\n---'.length
  if (bodyStart < text.length && text[bodyStart] === '\n') bodyStart += 1
  const body = text.slice(bodyStart)
  try {
    const data = yaml.load(block) as unknown
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return { fm: data as Record<string, unknown>, body }
    }
  } catch {
    /* fallthrough */
  }
  return { fm: null, body }
}

function walkTree(root: string): string[] {
  const out: string[] = []
  const skip = new Set(['__pycache__', '.git', 'node_modules', '.venv', 'venv'])

  const walk = (dir: string, rel: string) => {
    if (out.length >= MAX_LISTED_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue
      const abs = path.join(dir, e.name)
      const relNext = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(abs, relNext)
        if (out.length >= MAX_LISTED_FILES) return
      } else if (e.isFile() && e.name !== 'AGENT.md') {
        out.push(relNext)
        if (out.length >= MAX_LISTED_FILES) {
          out.push(`…and more (showing first ${MAX_LISTED_FILES})`)
          return
        }
      }
    }
  }
  walk(root, '')
  return out
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (x): x is string => typeof x === 'string' || typeof x === 'number',
  ).map((x) => String(x))
}

function parseToolsYaml(file: string): ToolsManifest {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return defaultToolsManifest()
  }
  let raw: unknown
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf8'))
  } catch {
    return defaultToolsManifest()
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultToolsManifest()
  }
  const data = raw as Record<string, unknown>
  const td =
    data.team_data && typeof data.team_data === 'object' && !Array.isArray(data.team_data)
      ? (data.team_data as Record<string, unknown>)
      : {}
  const exposureRaw = data.knowledge_exposure
  const exposure: 'summary' | 'full' | 'none' =
    exposureRaw === 'summary' || exposureRaw === 'full' || exposureRaw === 'none'
      ? exposureRaw
      : 'full'
  return {
    skills: stringList(data.skills),
    mcp_servers: stringList(data.mcp ?? data.mcp_servers),
    team_data_read: td.read !== false,
    team_data_write: !!td.write,
    team_data_allowed_tables: stringList(td.tables),
    team_data_write_fields: stringList(td.write_fields),
    knowledge_exposure: exposure,
    notes: String(data.notes ?? '').trim(),
  }
}

function loadFilePersona(
  mdPath: string,
  source: PersonaDef['source'],
): PersonaDef | null {
  let text: string
  try {
    text = fs.readFileSync(mdPath, 'utf8')
  } catch {
    return null
  }
  const { fm: fmRaw, body } = splitFrontmatter(text)
  const fm = fmRaw ?? {}
  const name =
    typeof fm.name === 'string' && fm.name ? fm.name : path.basename(mdPath, '.md')
  if (!name) return null
  const tools = defaultToolsManifest()
  if (Array.isArray(fm.skills)) tools.skills = stringList(fm.skills)
  if (Array.isArray(fm.mcp)) tools.mcp_servers = stringList(fm.mcp)
  return {
    name,
    description: String(fm.description ?? '').trim(),
    kind: 'file',
    path: mdPath,
    body: body.trim(),
    source,
    model:
      typeof fm.model === 'string' && fm.model.trim()
        ? String(fm.model).trim()
        : null,
    file_tree: [],
    tools,
    meta: fm,
  }
}

function loadDirPersona(
  agentDir: string,
  source: PersonaDef['source'],
): PersonaDef | null {
  const md = path.join(agentDir, 'AGENT.md')
  if (!fs.existsSync(md) || !fs.statSync(md).isFile()) return null
  let text: string
  try {
    text = fs.readFileSync(md, 'utf8')
  } catch {
    return null
  }
  const { fm: fmRaw, body } = splitFrontmatter(text)
  const fm = fmRaw ?? {}
  const name =
    typeof fm.name === 'string' && fm.name ? fm.name : path.basename(agentDir)
  if (!name) return null
  let tools = parseToolsYaml(path.join(agentDir, 'tools.yaml'))
  // Frontmatter overrides tools.yaml for skill / mcp lists.
  if (Array.isArray(fm.skills)) tools = { ...tools, skills: stringList(fm.skills) }
  if (Array.isArray(fm.mcp)) tools = { ...tools, mcp_servers: stringList(fm.mcp) }
  return {
    name,
    description: String(fm.description ?? '').trim(),
    kind: 'dir',
    path: agentDir,
    body: body.trim(),
    source,
    model:
      typeof fm.model === 'string' && fm.model.trim()
        ? String(fm.model).trim()
        : null,
    file_tree: walkTree(agentDir),
    tools,
    meta: fm,
  }
}

function scanRoots(
  roots: [string, PersonaDef['source']][],
): Map<string, PersonaDef> {
  const out = new Map<string, PersonaDef>()
  for (const [root, source] of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      const abs = path.join(root, e.name)
      if (e.isDirectory()) {
        const persona = loadDirPersona(abs, source)
        if (persona) out.set(persona.name, persona)
      }
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const persona = loadFilePersona(path.join(root, e.name), source)
      if (persona) out.set(persona.name, persona)
    }
  }
  return out
}

export function listPersonas(companyDir?: string | null): Map<string, PersonaDef> {
  const roots: [string, PersonaDef['source']][] = [
    [path.join(packagesRoot(), 'agents'), 'bundled'],
  ]
  if (companyDir) roots.push([path.join(companyDir, 'agents'), 'company'])
  roots.push([path.join(dataDir(), 'agents'), 'user'])
  return scanRoots(roots)
}

export function getPersona(
  name: string,
  companyDir?: string | null,
): PersonaDef | null {
  return listPersonas(companyDir).get(name) ?? null
}

export function loadPersonaFromPath(pathRef: string): PersonaDef | null {
  const resolved = pathRef.startsWith('~')
    ? path.join(process.env.HOME ?? '/', pathRef.slice(1))
    : pathRef
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    return null
  }
  if (stat.isFile() && resolved.endsWith('.md')) {
    return loadFilePersona(resolved, 'user')
  }
  if (stat.isDirectory()) {
    return loadDirPersona(resolved, 'user')
  }
  return null
}

export function synthesizeInlinePersona(opts: {
  inlinePrompt: string
  name: string
  description?: string
  skills?: string[]
}): PersonaDef {
  const tools = defaultToolsManifest()
  tools.skills = opts.skills ?? []
  return {
    name: opts.name,
    description: opts.description ?? '',
    kind: 'file',
    path: '<inline>',
    body: opts.inlinePrompt.trim(),
    source: 'inline',
    model: null,
    file_tree: [],
    tools,
    meta: {},
  }
}

export function resolveWithinPersona(
  persona: PersonaDef,
  relPath: string,
): string | null {
  if (persona.kind !== 'dir') return null
  if (!relPath || relPath.startsWith('/')) return null
  const candidate = path.resolve(persona.path, relPath)
  if (
    candidate !== persona.path &&
    !candidate.startsWith(persona.path + path.sep)
  ) {
    return null
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return null
  }
  return candidate
}
