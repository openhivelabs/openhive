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

const MAX_LISTED_FILES = 60
export const MAX_READABLE_FILE_BYTES = 256 * 1024

type SkillKind = 'agent' | 'typed'

interface SkillTriggers {
  /** Case-insensitive substring matches against the user's task text. */
  keywords?: string[]
  /** Regex sources; matched with `i` flag. Invalid patterns are ignored. */
  patterns?: string[]
}

export interface SkillDef {
  name: string
  description: string
  kind: SkillKind
  skillDir: string
  source: 'bundled' | 'user'
  /** Optional auto-hint rules injected into the system prompt when the
   *  user's goal appears to match this skill. Discovery aid only — the
   *  LLM still decides whether to activate. */
  triggers?: SkillTriggers
  // agent-skill
  body?: string
  fileTree?: string[]
  // typed-skill
  runtime?: 'python' | 'node'
  entrypoint?: string
  parameters?: Record<string, unknown>
  /** Tool-partition v2 concurrency class override (frontmatter
   *  `concurrency_class`). Reserved: the classifier does not yet consume
   *  this, it is only parsed and stored for a follow-up PR that wires
   *  per-skill overrides into `classifyTool`. */
  concurrencyClass?: 'serial_write' | 'safe_parallel'
}

function parseConcurrencyClass(
  raw: unknown,
): 'serial_write' | 'safe_parallel' | undefined {
  if (raw !== 'serial_write' && raw !== 'safe_parallel') return undefined
  return raw
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
  const triggers = parseTriggers(fm.triggers)
  const concurrencyClass = parseConcurrencyClass(fm.concurrency_class)

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
      triggers,
      runtime: runtime as 'python' | 'node',
      entrypoint: entrypointAbs,
      parameters: parametersRaw as Record<string, unknown>,
      concurrencyClass,
    }
  }

  return {
    name,
    description,
    kind: 'agent',
    skillDir,
    source,
    triggers,
    body: body.trim(),
    fileTree: walkSkillTree(skillDir),
    concurrencyClass,
  }
}

function parseTriggers(raw: unknown): SkillTriggers | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const keywords = Array.isArray(obj.keywords)
    ? obj.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    : undefined
  const patterns = Array.isArray(obj.patterns)
    ? obj.patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : undefined
  if (!keywords?.length && !patterns?.length) return undefined
  return { keywords, patterns }
}

/** Rule-match the user's goal against skills' `triggers:` frontmatter and
 *  return the subset that plausibly applies. Keyword matches are case-
 *  insensitive substrings; patterns compile with the `i` flag. Invalid
 *  regex sources are silently skipped so one bad YAML entry can't crash
 *  skill discovery. */
export function matchSkillHints(
  text: string,
  skills: SkillDef[],
): SkillDef[] {
  const lower = text.toLowerCase()
  const out: SkillDef[] = []
  for (const s of skills) {
    const t = s.triggers
    if (!t) continue
    let hit = false
    if (t.keywords) {
      for (const k of t.keywords) {
        if (lower.includes(k.toLowerCase())) {
          hit = true
          break
        }
      }
    }
    if (!hit && t.patterns) {
      for (const p of t.patterns) {
        try {
          if (new RegExp(p, 'i').test(text)) {
            hit = true
            break
          }
        } catch {
          /* invalid regex: skip */
        }
      }
    }
    if (hit) out.push(s)
  }
  return out
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

function listSkills(): Map<string, SkillDef> {
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

function invalidateSkillCache(): void {
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
