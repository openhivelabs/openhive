/**
 * Agent Frame — portable, single-agent package.
 *
 * Sibling of Team Frame (`frames.ts`) but one level down: instead of packaging
 * an entire team (agents + edges + dashboard + schema), this packages a single
 * agent — role, provider, model, prompt, skills, persona bundle — so users can
 * drop a known-good operative into an existing team.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { saveTeam, type TeamDict } from './companies'
import { companyDir, packagesRoot, teamYamlPath } from './paths'
import { CLAUDE_CODE_MODELS, CODEX_MODELS } from './providers/models'

export const AGENT_FRAME_VERSION = 1

const SLUG_RE = /[^a-z0-9-]+/g

function slugify(text: string, fallback = 'agent'): string {
  const s = text.toLowerCase().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '')
  return s || fallback
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(3).toString('hex')}`
}

function defaultModelFor(providerId: string): string {
  if (providerId === 'claude-code') {
    return CLAUDE_CODE_MODELS.find((m) => m.default)?.id ?? CLAUDE_CODE_MODELS[0]?.id ?? ''
  }
  if (providerId === 'codex') {
    return CODEX_MODELS.find((m) => m.default)?.id ?? CODEX_MODELS[0]?.id ?? ''
  }
  if (providerId === 'copilot') return 'gpt-5-mini'
  return ''
}

function readYamlSafe(file: string): Record<string, unknown> | null {
  try {
    const raw = yaml.load(fs.readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    return raw as Record<string, unknown>
  } catch {
    return null
  }
}

function personaNameFromMd(md: string): string | null {
  if (!md.startsWith('---')) return null
  const end = md.indexOf('\n---', 3)
  if (end < 0) return null
  const block = md.slice(3, end)
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    if (key === 'name') {
      return line.slice(idx + 1).trim().replace(/^["']|["']$/g, '') || null
    }
  }
  return null
}

function bundlePersonaFiles(pathRef: string): Record<string, string> {
  const resolved = pathRef.startsWith('~')
    ? path.join(process.env.HOME ?? path.parse(process.cwd()).root, pathRef.slice(1))
    : pathRef
  const out: Record<string, string> = {}
  try {
    const stat = fs.statSync(resolved)
    if (stat.isFile() && resolved.endsWith('.md')) {
      const text = fs.readFileSync(resolved, 'utf8')
      out[path.basename(resolved)] = text
      out.__name__ = personaNameFromMd(text) ?? path.basename(resolved, '.md')
      return out
    }
    if (!stat.isDirectory()) return {}
  } catch {
    return {}
  }
  const agentMd = path.join(resolved, 'AGENT.md')
  if (!fs.existsSync(agentMd) || !fs.statSync(agentMd).isFile()) return {}
  const TEXT_EXTS = new Set(['.md', '.yaml', '.yml', '.txt', '.json'])
  const MAX_BYTES = 128 * 1024
  const SKIP = new Set(['__pycache__', '.git', 'node_modules', '.venv', 'venv'])
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      const relNext = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(abs, relNext)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!TEXT_EXTS.has(ext)) continue
        try {
          const data = fs.readFileSync(abs, 'utf8')
          if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) continue
          out[relNext] = data
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  walk(resolved, '')
  const agent = out['AGENT.md'] ?? ''
  out.__name__ = personaNameFromMd(agent) ?? path.basename(resolved)
  return out
}

// -------- export --------

export interface AgentFrame {
  openhive_agent_frame: 1
  name: string
  description: string
  version: string
  created_at: string
  tags: string[]
  agent: Record<string, unknown>
  persona_assets: Record<string, { files: Record<string, string>; name: string }>
  requires: { skills: string[]; providers: string[] }
}

export function buildAgentFrame(
  companySlug: string,
  teamSlug: string,
  agentId: string,
): AgentFrame {
  const teamPath = teamYamlPath(companySlug, teamSlug)
  if (!fs.existsSync(teamPath) || !fs.statSync(teamPath).isFile()) {
    const err = new Error(`team not found: ${companySlug}/${teamSlug}`)
    ;(err as Error & { code?: string }).code = 'ENOENT'
    throw err
  }
  const team = readYamlSafe(teamPath)
  if (!team) throw new Error('team yaml is empty or invalid')
  const rawAgents = Array.isArray(team.agents) ? (team.agents as unknown[]) : []
  const src = rawAgents.find(
    (a) => a && typeof a === 'object' && !Array.isArray(a) && (a as Record<string, unknown>).id === agentId,
  ) as Record<string, unknown> | undefined
  if (!src) {
    const err = new Error(`agent not found: ${agentId}`)
    ;(err as Error & { code?: string }).code = 'ENOENT'
    throw err
  }

  // Strip team-specific fields (id, position) but keep the rest.
  const agentOut: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === 'id' || k === 'position') continue
    agentOut[k] = v
  }

  const personaAssets: Record<string, { files: Record<string, string>; name: string }> = {}
  const pathRef = agentOut.persona_path
  if (typeof pathRef === 'string' && pathRef) {
    const files = bundlePersonaFiles(pathRef)
    if (Object.keys(files).length > 0) {
      const baseSlug = slugify(
        files.__name__ ?? path.basename(pathRef, path.extname(pathRef)),
        'persona',
      )
      const stripped: Record<string, string> = {}
      for (const [k, v] of Object.entries(files)) {
        if (!k.startsWith('__')) stripped[k] = v
      }
      personaAssets[baseSlug] = { files: stripped, name: files.__name__ ?? baseSlug }
      agentOut.persona_bundle_key = baseSlug
      delete agentOut.persona_path
    }
  }

  const skills: string[] = []
  for (const s of (agentOut.skills as unknown[] | undefined) ?? []) {
    if (typeof s === 'string') skills.push(s)
  }
  const providers: string[] = []
  if (typeof agentOut.provider_id === 'string' && agentOut.provider_id) {
    providers.push(agentOut.provider_id as string)
  }

  const role = typeof src.role === 'string' ? src.role : ''
  const label = typeof src.label === 'string' ? src.label : ''
  const displayName = role || label || agentId

  return {
    openhive_agent_frame: AGENT_FRAME_VERSION,
    name: displayName,
    description: '',
    version: '1.0.0',
    created_at: new Date().toISOString(),
    tags: [],
    agent: agentOut,
    persona_assets: personaAssets,
    requires: {
      skills: [...new Set(skills)].sort(),
      providers: [...new Set(providers)].sort(),
    },
  }
}

// -------- install --------

export interface InstallAgentOpts {
  connectedProviders?: Set<string>
  installedSkills?: Set<string>
}

export interface InstallAgentResult {
  agent: Record<string, unknown>
  warnings: string[]
}

export function installAgentFrame(
  targetCompanySlug: string,
  targetTeamSlug: string,
  frame: unknown,
  opts: InstallAgentOpts = {},
): InstallAgentResult {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('agent frame must be an object')
  }
  const fObj = frame as Record<string, unknown>
  if (fObj.openhive_agent_frame !== AGENT_FRAME_VERSION) {
    throw new Error(
      `unsupported agent frame version: ${JSON.stringify(fObj.openhive_agent_frame)} (expected ${AGENT_FRAME_VERSION})`,
    )
  }
  const src = fObj.agent
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    throw new Error('frame.agent is missing or invalid')
  }

  const compDir = companyDir(targetCompanySlug)
  if (
    !fs.existsSync(path.join(compDir, 'company.yaml')) ||
    !fs.statSync(path.join(compDir, 'company.yaml')).isFile()
  ) {
    const err = new Error(`target company not found: ${targetCompanySlug}`)
    ;(err as Error & { code?: string }).code = 'ENOENT'
    throw err
  }
  const teamPath = teamYamlPath(targetCompanySlug, targetTeamSlug)
  if (!fs.existsSync(teamPath) || !fs.statSync(teamPath).isFile()) {
    const err = new Error(`target team not found: ${targetCompanySlug}/${targetTeamSlug}`)
    ;(err as Error & { code?: string }).code = 'ENOENT'
    throw err
  }
  const team = readYamlSafe(teamPath)
  if (!team) throw new Error('target team yaml is empty or invalid')

  const warnings: string[] = []
  let fallbackProvider: string | null = null
  if (opts.connectedProviders && opts.connectedProviders.size > 0) {
    fallbackProvider = [...opts.connectedProviders].sort()[0] ?? null
  }

  // Unpack persona bundle if present.
  const personaBundlePaths = new Map<string, string>()
  const rawAssets = (fObj.persona_assets as Record<string, unknown> | undefined) ?? {}
  if (rawAssets && typeof rawAssets === 'object' && !Array.isArray(rawAssets)) {
    const agentsDir = path.join(compDir, 'agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    for (const [key, payloadRaw] of Object.entries(rawAssets)) {
      if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) continue
      const payload = payloadRaw as Record<string, unknown>
      const files = payload.files
      if (!files || typeof files !== 'object' || Array.isArray(files)) continue
      const slugBase = slugify(String(payload.name ?? key), 'persona')
      let target = path.join(agentsDir, slugBase)
      let m = 1
      while (fs.existsSync(target)) {
        m += 1
        target = path.join(agentsDir, `${slugBase}-${m}`)
      }
      fs.mkdirSync(target, { recursive: true })
      for (const [rel, textRaw] of Object.entries(files as Record<string, unknown>)) {
        if (typeof rel !== 'string' || typeof textRaw !== 'string') continue
        const safeRel = rel.replace(/^\/+/, '')
        if (safeRel.split('/').some((p) => p === '..')) continue
        const dst = path.join(target, safeRel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.writeFileSync(dst, textRaw, 'utf8')
      }
      personaBundlePaths.set(key, target)
    }
  }

  const srcObj = src as Record<string, unknown>
  const agentId = newId('a')
  const agent: Record<string, unknown> = { ...srcObj, id: agentId }
  const bundleKey = agent.persona_bundle_key
  delete agent.persona_bundle_key
  if (typeof bundleKey === 'string' && personaBundlePaths.has(bundleKey)) {
    agent.persona_path = personaBundlePaths.get(bundleKey)
  }

  const prov = agent.provider_id
  const hasProv = typeof prov === 'string' && (prov as string).length > 0
  if (opts.connectedProviders && hasProv && !opts.connectedProviders.has(prov as string)) {
    if (fallbackProvider) {
      warnings.push(
        `Agent used provider '${prov}' which isn't connected — fell back to '${fallbackProvider}'.`,
      )
      agent.provider_id = fallbackProvider
    } else {
      warnings.push(
        `Agent used provider '${prov}' but no provider is connected. Connect one in Settings.`,
      )
    }
  } else if (!hasProv && fallbackProvider) {
    agent.provider_id = fallbackProvider
  }
  const chosenProv = typeof agent.provider_id === 'string' ? agent.provider_id : ''
  if (chosenProv && (typeof agent.model !== 'string' || (agent.model as string).length === 0)) {
    const def = defaultModelFor(chosenProv)
    if (def) agent.model = def
  }
  // Fresh agents start unpositioned; the UI auto-layout will place them.
  agent.position = { x: 0, y: 0 }

  // Skill availability warnings.
  const installed = opts.installedSkills ?? new Set<string>()
  const required = new Set<string>()
  for (const s of (agent.skills as unknown[] | undefined) ?? []) {
    if (typeof s === 'string') required.add(s)
  }
  const missing = [...required].filter((s) => !installed.has(s)).sort()
  for (const sk of missing) {
    warnings.push(
      `Required skill '${sk}' is not installed — agent will silently skip it until you install it.`,
    )
  }

  // Persist into the target team yaml.
  const existingAgents = Array.isArray(team.agents) ? [...(team.agents as unknown[])] : []
  existingAgents.push(agent)
  const nextTeam: TeamDict = {
    ...(team as TeamDict),
    slug: String(team.slug ?? targetTeamSlug),
    agents: existingAgents as Record<string, unknown>[],
  }
  saveTeam(targetCompanySlug, nextTeam)

  return { agent, warnings }
}

// -------- gallery --------

export interface AgentGalleryEntry {
  id: string
  name: string
  description: string
  version: string
  tags: string[]
  role: string
  provider_id: string
  model: string
  has_persona: boolean
  requires: { skills: string[]; providers: string[] }
  frame: Record<string, unknown>
}

export function listAgentGallery(): AgentGalleryEntry[] {
  const root = path.join(packagesRoot(), 'agent-frames')
  if (!fs.existsSync(root)) return []
  const out: AgentGalleryEntry[] = []
  let entries: string[]
  try {
    entries = fs
      .readdirSync(root)
      .filter((f) => f.endsWith('.openhive-agent-frame.yaml'))
      .sort()
  } catch {
    return []
  }
  for (const name of entries) {
    const file = path.join(root, name)
    let raw: unknown
    try {
      raw = yaml.load(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const data = raw as Record<string, unknown>
    if (data.openhive_agent_frame !== AGENT_FRAME_VERSION) continue
    const agent = (data.agent as Record<string, unknown> | undefined) ?? {}
    const requires = (data.requires as Record<string, unknown> | undefined) ?? {}
    const assets = (data.persona_assets as Record<string, unknown> | undefined) ?? {}
    out.push({
      id: name.replace(/\.openhive-agent-frame\.yaml$/, ''),
      name: String(data.name ?? name),
      description: String(data.description ?? ''),
      version: String(data.version ?? '1.0.0'),
      tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
      role: String(agent.role ?? ''),
      provider_id: String(agent.provider_id ?? ''),
      model: String(agent.model ?? ''),
      has_persona: Object.keys(assets).length > 0,
      requires: {
        skills: Array.isArray(requires.skills) ? (requires.skills as string[]) : [],
        providers: Array.isArray(requires.providers) ? (requires.providers as string[]) : [],
      },
      frame: data,
    })
  }
  return out
}
