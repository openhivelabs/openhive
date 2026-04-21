/**
 * Agent runtime — resolves a node's persona, composes prompts, builds tools.
 * Ports apps/server/openhive/agents/runtime.py.
 *
 * Persona resolution is eager (once per node spin-up); on-demand file access
 * happens through the `list_agent_files` + `read_agent_file` tools.
 */

import fs from 'node:fs'
import {
  MAX_READABLE_FILE_BYTES,
  type PersonaDef,
  getPersona,
  loadPersonaFromPath,
  resolveWithinPersona,
  synthesizeInlinePersona,
} from './loader'
import type { AgentSpec, TeamSpec } from '../engine/team'
import type { Tool } from '../tools/base'

export function resolvePersona(
  node: AgentSpec,
  _team: TeamSpec,
  opts: { companyDir?: string | null } = {},
): PersonaDef {
  if (node.persona_path) {
    const p = loadPersonaFromPath(node.persona_path)
    if (p) return p
  }
  if (node.persona_name) {
    const p = getPersona(node.persona_name, opts.companyDir ?? null)
    if (p) return p
  }
  return synthesizeInlinePersona({
    inlinePrompt: node.system_prompt,
    name: `${node.id}:${node.role}`,
    description: node.label,
    skills: node.skills,
  })
}

export function effectiveSkills(node: AgentSpec, persona: PersonaDef): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...(node.skills ?? []), ...(persona.tools.skills ?? [])]) {
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

export function effectiveMcpServers(
  teamMcp: string[],
  persona: PersonaDef,
): string[] {
  const personaSet = new Set(persona.tools.mcp_servers ?? [])
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of teamMcp ?? []) {
    if (seen.has(s)) continue
    // Persona didn't declare any → team allow-list applies unchanged.
    if (personaSet.size > 0 && !personaSet.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** Compose the system-prompt body to feed the LLM. Directory personas get a
 *  file-tree directory appended so the LLM knows what it can read on demand. */
export function composePersonaBody(persona: PersonaDef): string {
  const base = (persona.body ?? '').trimEnd()
  if (persona.kind !== 'dir' || persona.file_tree.length === 0) return base

  const parts: string[] = []
  if (base) parts.push(base)
  parts.push('\n\n# Your knowledge base\n')
  parts.push(
    'You have a persona directory with supplementary files (knowledge, ' +
      'examples, behaviors). Load them on demand — do not assume their ' +
      'contents. Call `list_agent_files()` to re-scan the directory, and ' +
      '`read_agent_file(path)` to fetch a specific file when a task calls ' +
      'for it. Prefer reading the smallest file that answers the question.\n',
  )
  parts.push('\nAvailable files:\n')
  for (const p of persona.file_tree) parts.push(`- \`${p}\`\n`)
  if (persona.tools.notes) {
    parts.push(`\n**Operator notes:** ${persona.tools.notes}\n`)
  }
  return parts.join('')
}

// -------- tools --------

export function makePersonaTools(persona: PersonaDef): Tool[] {
  if (persona.kind !== 'dir' || persona.file_tree.length === 0) return []

  const listTool: Tool = {
    name: 'list_agent_files',
    description:
      `List all files in your persona directory (${persona.name}). ` +
      'Useful when you need to re-discover what knowledge/examples are ' +
      'attached. Returns paths relative to the persona root.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () =>
      JSON.stringify({
        ok: true,
        persona: persona.name,
        files: persona.file_tree.filter((p) => !p.startsWith('…')),
      }),
  }

  const readTool: Tool = {
    name: 'read_agent_file',
    description:
      'Read one file from your persona directory. Call ' +
      "`list_agent_files()` first if you don't know the exact path. " +
      'Content is returned as plain text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path relative to the persona root ' +
            "(e.g. 'knowledge/pricing.md').",
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const rel = String(args.path ?? '')
      const resolved = resolveWithinPersona(persona, rel)
      if (!resolved) {
        return JSON.stringify({
          ok: false,
          error: `unknown or unreadable file: ${JSON.stringify(rel)}`,
        })
      }
      try {
        const size = fs.statSync(resolved).size
        if (size > MAX_READABLE_FILE_BYTES) {
          return JSON.stringify({
            ok: false,
            error: `file too large (${size} bytes, limit ${MAX_READABLE_FILE_BYTES})`,
          })
        }
        const content = fs.readFileSync(resolved, 'utf8')
        return JSON.stringify({ ok: true, path: rel, content })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return JSON.stringify({ ok: false, error: `read failed: ${msg}` })
      }
    },
  }

  return [listTool, readTool]
}
