import fs from 'node:fs'
import path from 'node:path'
import { listPersonas } from '@/lib/server/agents/loader'
import { extractJson, loadSkillBody, rid, slugify } from '@/lib/server/ai-generators/common'
import { companyDir, packagesRoot } from '@/lib/server/paths'
import { chatCompletion } from '@/lib/server/providers/copilot'
import { ScopeViolationError, scopedWriteAll } from '@/lib/server/scoped-fs'
import { Hono } from 'hono'

export const agents = new Hono()

const AGENT_CREATOR_SKILL = loadSkillBody('agent-creator')

// Surface the canonical reference docs so the LLM writes AGENT.md / knowledge
// files the same shape the loader expects. Keeping them as raw strings (not
// summaries) lets the model copy structure verbatim when helpful.
function loadReference(name: string): string {
  const p = path.join(packagesRoot(), 'skills', 'agent-creator', 'reference', name)
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
const REF_AGENT_MD_SPEC = loadReference('agent_md_spec.md')
const REF_TEMPLATES = loadReference('templates.md')

const OUTPUT_DIRECTIVE = `You are OpenHive's single-agent designer. Use the \`agent-creator\` guidance
above (plus the reference docs) to produce a persona for one node on the
canvas.

## Two response shapes

Pick ONE based on complexity:

### A) Lightweight — inline prompt only

When the role is a simple, one-shot operator (≤ 2 paragraphs of instruction
would cover it) and no domain knowledge or few-shot examples are needed.
Return:

\`\`\`json
{
  "mode": "inline",
  "role": "<short role name, 1-3 words>",
  "label": "<one-sentence description>",
  "system_prompt": "<2-4 sentences, imperative voice, concrete>",
  "skills": []
}
\`\`\`

### B) Rich — persona directory

When the role has real domain knowledge, needs few-shot examples, has
non-trivial behavioural rules, or will be reused. Return a full persona
bundle. The server will write each file into the agent's own directory.

\`\`\`json
{
  "mode": "rich",
  "role": "<short role name>",
  "label": "<one-sentence description>",
  "skills": [],
  "persona_assets": {
    "files": {
      "AGENT.md": "<frontmatter + body following agent_md_spec.md>",
      "knowledge/<topic>.md": "<domain knowledge, 200-600 words>",
      "knowledge/<another-topic>.md": "...",
      "behaviors/<rule>.md": "<one rule, tight>",
      "examples/<scenario>.md": "<worked example>"
    }
  }
}
\`\`\`

## Rules

- Pick the nearest template (lead / researcher / reviewer / writer) and
  adapt its structure to the user's domain. Do NOT just copy the template
  wording — the files must be specific to the user's description.
- AGENT.md MUST start with YAML frontmatter (\`name\`, \`description\`).
  Follow the body structure: Persona, Decision tree, Knowledge index,
  Escalation. Keep under ~2KB.
- Do NOT include \`tools.yaml\`. Persona-level skill/MCP scoping is opt-in
  and almost never needed — the team's allow list already governs what
  this agent can use. Only include tools.yaml if the user explicitly asked
  to restrict this agent to a subset of team skills.
- \`skills\` at the top level is a soft hint (UI filters); real skill
  allowance is decided at team level. Leave it empty unless the user
  clearly named a skill like "pptx" or "web-fetch".
- File paths in \`persona_assets.files\` must be relative, lowercase,
  hyphen-separated, under 60 files total.
- Return ONLY the JSON object. No prose, no markdown fences.`

interface GenerateBody {
  description?: string
  company_slug?: string
}

export interface LibraryPersona {
  name: string
  description: string
  kind: 'file' | 'dir'
  source: 'bundled' | 'company' | 'user' | 'inline'
  path: string
  file_tree: string[]
  model: string | null
  skills: string[]
  mcp_servers: string[]
}

/**
 * Write an LLM-generated persona bundle. The LLM picks file names inside
 * `persona_assets.files`, so every path must be clamped to the agent's own
 * directory — we must never let a crafted `../` hop out into the parent
 * company.yaml or another team. All writes go through `scopedWriteAll`,
 * which resolves each relative path against the target base and rejects
 * anything that resolves outside.
 */
function writePersonaBundle(
  companySlug: string,
  baseName: string,
  files: Record<string, string>,
): string {
  const agentsDir = path.join(companyDir(companySlug), 'agents')
  fs.mkdirSync(agentsDir, { recursive: true })
  const slugBase = slugify(baseName) || 'persona'
  let target = path.join(agentsDir, slugBase)
  let n = 1
  while (fs.existsSync(target)) {
    n += 1
    target = path.join(agentsDir, `${slugBase}-${n}`)
  }
  fs.mkdirSync(target, { recursive: true })
  scopedWriteAll({ base: target, allowPattern: /^[A-Za-z0-9._\-/]+$/ }, files, {
    maxFiles: 60,
    maxBytesPerFile: 64 * 1024,
  })
  return target
}

// POST /api/agents/generate
agents.post('/generate', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as GenerateBody
  const description = body.description?.trim()
  const companySlug = body.company_slug?.trim() || null
  if (!description) {
    return c.json({ detail: 'description is required' }, 400)
  }
  try {
    const system = [
      AGENT_CREATOR_SKILL,
      '---',
      '# Reference: AGENT.md spec',
      REF_AGENT_MD_SPEC,
      '---',
      '# Reference: templates',
      REF_TEMPLATES,
      '---',
      OUTPUT_DIRECTIVE,
    ].join('\n\n')
    const text = await chatCompletion({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: description },
      ],
      temperature: 0.4,
    })
    const meta = extractJson(text)

    const role = String(meta.role ?? '').trim() || 'Member'
    const label = String(meta.label ?? '').trim() || 'Copilot'
    const skills = Array.isArray(meta.skills)
      ? meta.skills
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
      : []

    const out: Record<string, unknown> = {
      id: rid('a'),
      role,
      label,
      provider_id: 'copilot',
      model: 'gpt-5-mini',
      skills,
      position: { x: 0, y: 0 },
    }

    const mode = String(meta.mode ?? '').trim()
    const assets = meta.persona_assets as { files?: Record<string, unknown> } | undefined
    const files =
      assets && typeof assets === 'object' && !Array.isArray(assets)
        ? (assets.files as Record<string, unknown> | undefined)
        : undefined

    if (
      mode === 'rich' &&
      companySlug &&
      files &&
      typeof files === 'object' &&
      !Array.isArray(files) &&
      Object.keys(files).length > 0
    ) {
      // Persist the persona bundle next to the company, set persona_path on
      // the returned agent so the NodeEditor's tree pulls it straight from
      // disk via listPersonas().
      const strFiles: Record<string, string> = {}
      for (const [k, v] of Object.entries(files)) {
        if (typeof k === 'string' && typeof v === 'string') strFiles[k] = v
      }
      if (!strFiles['AGENT.md']) {
        // LLM violated the contract — fall back to inline so the agent still
        // works. Surface a warning.
        out.system_prompt = String(meta.system_prompt ?? '').trim() || `You are a ${role}.`
        out.warnings = ['rich mode missing AGENT.md — fell back to inline prompt']
      } else {
        const personaPath = writePersonaBundle(companySlug, role || 'persona', strFiles)
        out.persona_path = personaPath
        // Parse persona name from the AGENT.md frontmatter if present — lets
        // the client resolve it back via listPersonas later.
        const fm = /^---\s*\n([\s\S]*?)\n---/.exec(strFiles['AGENT.md'])
        if (fm) {
          const nameMatch = /(?:^|\n)name:\s*(.+)/.exec(fm[1] ?? '')
          const captured = nameMatch?.[1]
          if (captured) {
            out.persona_name = captured.trim().replace(/^["']|["']$/g, '')
          }
        }
      }
    } else {
      // Lightweight / no company scope — inline prompt.
      out.system_prompt = String(meta.system_prompt ?? '').trim() || `You are a ${role}.`
    }

    return c.json(out)
  } catch (exc) {
    if (exc instanceof ScopeViolationError) {
      return c.json({ detail: `persona file path rejected: ${exc.message}` }, 400)
    }
    return c.json({ detail: exc instanceof Error ? exc.message : String(exc) }, 500)
  }
})

// GET /api/agents/library
agents.get('/library', (c) => {
  const companySlug = c.req.query('company') ?? null
  const compDir = companySlug ? companyDir(companySlug) : null
  const personas = listPersonas(compDir)
  const out: LibraryPersona[] = []
  for (const p of personas.values()) {
    out.push({
      name: p.name,
      description: p.description,
      kind: p.kind,
      source: p.source,
      path: p.path,
      file_tree: p.file_tree,
      model: p.model,
      skills: p.tools.skills,
      mcp_servers: p.tools.mcp_servers,
    })
  }
  // Keep a stable order: bundled first, then company, then user.
  const rank = { bundled: 0, company: 1, user: 2, inline: 3 }
  out.sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name))
  return c.json(out)
})
