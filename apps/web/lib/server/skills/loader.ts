/**
 * SKILL.md discovery + parsing.
 * Ports apps/server/openhive/skills/loader.py.
 *
 * Two skill formats coexist:
 *   1. Agent skill (Anthropic format): frontmatter has name + description;
 *      body becomes a system-prompt guide, scripts/files read on demand.
 *   2. Typed tool skill: frontmatter adds runtime + entrypoint + parameters;
 *      skill becomes one LLM tool whose handler subprocesses the entrypoint.
 *
 * Scanning roots:
 *   - bundled:        <repo>/packages/skills/:name/SKILL.md
 *   - user-installed: ~/.openhive/skills/:name/SKILL.md (overrides bundled)
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { packagesRoot, skillsRoot } from '../paths'

export const MAX_LISTED_FILES = 60
export const MAX_READABLE_FILE_BYTES = 256 * 1024

export type SkillKind = 'agent' | 'typed'

export interface SkillDef {
  name: string
  description: string
  kind: SkillKind
  skillDir: string
  source: 'bundled' | 'user'
  // agent-skill
  body?: string
  fileTree?: string[]
  // typed-skill
  runtime?: 'python' | 'node'
  entrypoint?: string
  parameters?: Record<string, unknown>
}

function bundledRoot(): string {
  return path.join(packagesRoot(), 'skills')
}

function userRoot(): string {
  return skillsRoot()
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

function walkSkillTree(skillDir: string): string[] {
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
      } else if (e.isFile() && e.name !== 'SKILL.md') {
        out.push(relNext)
        if (out.length >= MAX_LISTED_FILES) {
          out.push(`…and more (showing first ${MAX_LISTED_FILES})`)
          return
        }
      }
    }
  }
  walk(skillDir, '')
  return out
}

function loadOne(
  skillMd: string,
  source: 'bundled' | 'user',
): SkillDef | null {
  let text: string
  try {
    text = fs.readFileSync(skillMd, 'utf8')
  } catch {
    return null
  }
  const { fm, body } = splitFrontmatter(text)
  if (!fm) return null
  const name = fm.name
  if (typeof name !== 'string' || !name) return null
  const description = String(fm.description ?? '').trim()
  const skillDir = path.dirname(skillMd)

  // Typed skill discriminator: entrypoint present.
  const entrypointRel = fm.entrypoint
  if (typeof entrypointRel === 'string' && entrypointRel) {
    const runtime = String(fm.runtime ?? '').trim().toLowerCase()
    if (runtime !== 'python' && runtime !== 'node') return null
    const parametersRaw = fm.parameters ?? { type: 'object', properties: {} }
    if (
      !parametersRaw ||
      typeof parametersRaw !== 'object' ||
      Array.isArray(parametersRaw)
    ) {
      return null
    }
    const entrypointAbs = path.resolve(skillDir, entrypointRel)
    // Refuse traversal outside the skill directory.
    if (
      entrypointAbs !== skillDir &&
      !entrypointAbs.startsWith(skillDir + path.sep)
    ) {
      return null
    }
    if (!fs.existsSync(entrypointAbs) || !fs.statSync(entrypointAbs).isFile()) {
      return null
    }
    return {
      name,
      description,
      kind: 'typed',
      skillDir,
      source,
      runtime: runtime as 'python' | 'node',
      entrypoint: entrypointAbs,
      parameters: parametersRaw as Record<string, unknown>,
    }
  }

  return {
    name,
    description,
    kind: 'agent',
    skillDir,
    source,
    body: body.trim(),
    fileTree: walkSkillTree(skillDir),
  }
}

function scan(root: string, source: 'bundled' | 'user'): Map<string, SkillDef> {
  const out = new Map<string, SkillDef>()
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return out
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const e of entries) {
    const md = path.join(root, e.name, 'SKILL.md')
    if (!fs.existsSync(md) || !fs.statSync(md).isFile()) continue
    const skill = loadOne(md, source)
    if (skill) out.set(skill.name, skill)
  }
  return out
}

interface ListCache {
  expiresAt: number
  skills: Map<string, SkillDef>
}

const globalForCache = globalThis as unknown as {
  __openhive_skill_cache?: ListCache | null
}

const LIST_CACHE_TTL_MS = 5_000

export function listSkills(): Map<string, SkillDef> {
  const now = Date.now()
  const hit = globalForCache.__openhive_skill_cache
  if (hit && hit.expiresAt > now) return hit.skills
  const bundled = scan(bundledRoot(), 'bundled')
  const user = scan(userRoot(), 'user')
  // User overrides bundled.
  for (const [name, def] of user) bundled.set(name, def)
  globalForCache.__openhive_skill_cache = {
    expiresAt: now + LIST_CACHE_TTL_MS,
    skills: bundled,
  }
  return bundled
}

export function invalidateSkillCache(): void {
  globalForCache.__openhive_skill_cache = null
}

export function getSkill(name: string): SkillDef | null {
  return listSkills().get(name) ?? null
}

export function resolveWithinSkill(
  skill: SkillDef,
  relPath: string,
): string | null {
  if (!relPath || relPath.startsWith('/')) return null
  const candidate = path.resolve(skill.skillDir, relPath)
  if (
    candidate !== skill.skillDir &&
    !candidate.startsWith(skill.skillDir + path.sep)
  ) {
    return null
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return null
  }
  return candidate
}
