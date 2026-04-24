/**
 * Agent persona bundle scaffolder.
 *
 * Every OpenHive agent is backed by an AGENT.md directory under
 * `companies/{slug}/agents/{dir}/`. This module owns the write paths:
 *   - writePersonaBundle : write a pre-built file map (used by /api/agents/generate)
 *   - ensureAgentBundle  : mutate an agent dict in-place to guarantee it has a
 *     persona_path on disk. Scaffolds a minimal AGENT.md from the agent's
 *     system_prompt (or a generic fallback) if no bundle exists yet.
 *   - migrateAllAgents   : one-shot boot sweep — iterate every team yaml and
 *     scaffold agents that are still on the legacy inline-prompt model.
 */

import fs from 'node:fs'
import path from 'node:path'
import { companiesRoot, companyDir, teamYamlPath } from '@/lib/server/paths'
import { scopedWriteAll } from '@/lib/server/scoped-fs'
import { invalidateCachePrefix, readYamlCached, writeYaml } from '@/lib/server/yaml-io'

/**
 * Slugify for agent directory names. Unlike `common.ts#slugify` (which
 * falls back to the string `'team'` — its caller is team-creation), this
 * helper falls back to `agent-<idSuffix>` so a Korean role like "요약자"
 * gets a stable, agent-specific directory instead of colliding with a team
 * name.
 */
function agentDirBase(role: string, agentId: string): string {
  const s = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s) return s
  const suffix = agentId.replace(/[^a-z0-9]/gi, '').slice(-6) || 'bundle'
  return `agent-${suffix}`
}

const BUNDLE_ALLOW = /^[A-Za-z0-9._\-/]+$/
const BUNDLE_MAX_FILES = 60
const BUNDLE_MAX_BYTES_PER_FILE = 64 * 1024

/**
 * Write an arbitrary file map under `companies/{slug}/agents/{baseName}/`.
 * All paths are clamped by scopedWriteAll so LLM-picked filenames can't
 * escape via `../`. If the target directory already exists, suffixes with
 * `-2`, `-3`, … until a free slot is found.
 */
export function writePersonaBundle(
  companySlug: string,
  baseName: string,
  files: Record<string, string>,
  fallbackId = 'bundle',
): string {
  const agentsDir = path.join(companyDir(companySlug), 'agents')
  fs.mkdirSync(agentsDir, { recursive: true })
  const slugBase = agentDirBase(baseName, fallbackId)
  let target = path.join(agentsDir, slugBase)
  let n = 1
  while (fs.existsSync(target)) {
    n += 1
    target = path.join(agentsDir, `${slugBase}-${n}`)
  }
  fs.mkdirSync(target, { recursive: true })
  scopedWriteAll({ base: target, allowPattern: BUNDLE_ALLOW }, files, {
    maxFiles: BUNDLE_MAX_FILES,
    maxBytesPerFile: BUNDLE_MAX_BYTES_PER_FILE,
  })
  return target
}

/** YAML-escape a frontmatter string value (single quotes). */
function yamlStr(raw: string): string {
  const cleaned = raw.replace(/[\r\n]+/g, ' ').trim() || 'agent'
  return `'${cleaned.replace(/'/g, "''")}'`
}

/** Build a minimal AGENT.md body from an agent's existing system_prompt. */
function buildDefaultAgentMd(agent: Record<string, unknown>): string {
  const role = String(agent.role ?? '').trim() || 'Agent'
  const label = String(agent.label ?? '').trim() || role
  const persona = String(agent.system_prompt ?? '').trim() || `You are a ${role}.`
  const id = String(agent.id ?? 'bundle')
  const name = agentDirBase(role, id)
  const description =
    role.toLowerCase() === 'lead'
      ? 'Owns the conversation with the user and routes tasks to the right specialist.'
      : label
  return `---
name: ${yamlStr(name)}
description: ${yamlStr(description)}
---

# Persona
${persona}
`
}

/**
 * Guarantee the agent has a persona_path on disk.
 * Mutates `agent` in place (adds persona_path / persona_name, clears
 * system_prompt once the body has been migrated into AGENT.md).
 *
 * No-op when persona_path is already set and the directory exists.
 *
 * Returns true if a new bundle was written.
 */
export function ensureAgentBundle(
  companySlug: string,
  agent: Record<string, unknown>,
): boolean {
  const existingPath = typeof agent.persona_path === 'string' ? agent.persona_path : ''
  if (existingPath && fs.existsSync(existingPath) && fs.statSync(existingPath).isDirectory()) {
    // Already bundled. Make sure system_prompt isn't hanging around as a
    // shadow copy — AGENT.md is the source of truth now.
    if (agent.system_prompt) agent.system_prompt = ''
    return false
  }

  const agentMd = buildDefaultAgentMd(agent)
  const role = String(agent.role ?? '').trim() || 'agent'
  const id = String(agent.id ?? 'bundle')
  const target = writePersonaBundle(companySlug, role, { 'AGENT.md': agentMd }, id)
  agent.persona_path = target
  agent.persona_name = agentDirBase(role, id)
  agent.system_prompt = ''
  return true
}

/** New default for the per-turn tool-round budget. 8 was too tight for
 *  "research + document produce" flows — users hit the cap before the
 *  PDF/report step. 24 gives enough room for ~15 web fetches + skill
 *  activation + a few rounds of synthesis. */
export const DEFAULT_MAX_TOOL_ROUNDS_PER_TURN = 24

/**
 * Bump team.limits.max_tool_rounds_per_turn on an existing yaml dict if it's
 * below the new default. Mutates in place. Returns true when something changed.
 * Idempotent — safe to run every boot.
 */
export function ensureTeamLimits(team: Record<string, unknown>): boolean {
  const limitsRaw = team.limits
  const limits =
    limitsRaw && typeof limitsRaw === 'object' && !Array.isArray(limitsRaw)
      ? (limitsRaw as Record<string, unknown>)
      : {}
  const current = Number(limits.max_tool_rounds_per_turn ?? 0)
  if (current >= DEFAULT_MAX_TOOL_ROUNDS_PER_TURN) return false
  limits.max_tool_rounds_per_turn = DEFAULT_MAX_TOOL_ROUNDS_PER_TURN
  if (typeof limits.max_delegation_depth !== 'number') {
    limits.max_delegation_depth = 4
  }
  team.limits = limits
  return true
}

/**
 * One-shot boot migration. Walk every company/team yaml, call
 * ensureAgentBundle on each agent AND bump team.limits if still on the legacy
 * 8-round budget, and rewrite the yaml only if something changed. Idempotent
 * — safe to run every boot.
 */
export function migrateAllAgents(): {
  scanned: number
  migrated: number
  limits_bumped: number
} {
  let scanned = 0
  let migrated = 0
  let limitsBumped = 0
  const root = companiesRoot()
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { scanned, migrated, limits_bumped: limitsBumped }
  }
  const companies = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
  for (const c of companies) {
    const companySlug = c.name
    const teamsDir = path.join(root, companySlug, 'teams')
    if (!fs.existsSync(teamsDir) || !fs.statSync(teamsDir).isDirectory()) continue
    const files = fs.readdirSync(teamsDir).filter((f) => f.endsWith('.yaml'))
    for (const file of files) {
      const teamSlug = file.replace(/\.yaml$/, '')
      const yamlPath = teamYamlPath(companySlug, teamSlug)
      const team = readYamlCached(yamlPath) as Record<string, unknown> | null
      if (!team) continue
      const agents = Array.isArray(team.agents) ? (team.agents as Record<string, unknown>[]) : []
      let dirty = false
      for (const agent of agents) {
        scanned += 1
        if (ensureAgentBundle(companySlug, agent)) {
          migrated += 1
          dirty = true
        }
      }
      if (ensureTeamLimits(team)) {
        limitsBumped += 1
        dirty = true
      }
      if (dirty) {
        writeYaml(yamlPath, team)
        invalidateCachePrefix(yamlPath)
      }
    }
  }
  return { scanned, migrated, limits_bumped: limitsBumped }
}
