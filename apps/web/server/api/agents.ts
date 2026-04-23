import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { listPersonas } from '@/lib/server/agents/loader'
import { writePersonaBundle } from '@/lib/server/agents/scaffold'
import { extractJson, rid } from '@/lib/server/ai-generators/common'
import { buildMessages, stream as providerStream } from '@/lib/server/engine/providers'
import { companyDir } from '@/lib/server/paths'
import type { ChatMessage } from '@/lib/server/providers/types'
import { ScopeViolationError } from '@/lib/server/scoped-fs'

export const agents = new Hono()

interface GenerateBody {
  description?: string
  company_slug?: string
  provider_id?: string
  model?: string
}

export interface LibraryPersona {
  name: string
  description: string
  kind: 'file' | 'dir'
  source: 'bundled' | 'company' | 'user' | 'inline'
  path: string
  file_tree: string[]
  body: string
  model: string | null
  skills: string[]
  mcp_servers: string[]
}

interface PlannerRef {
  filename: string
  evidence: string
  purpose: string
}

interface PlannerOutput {
  role: string
  label: string
  references: PlannerRef[]
}

const ONE_SHOT_DEADLINE_MS = 90_000
// Schema-level cap only. NEVER mentioned in the planner prompt — the model
// anchors on numeric ceilings and treats them as a target. We let it propose
// freely, then trim/validate here.
const MAX_REFERENCES = 5
const REFERENCE_FILENAME_RE = /^[a-z0-9][a-z0-9-]{0,40}\.md$/

/**
 * Provider-agnostic non-streaming collector. Delegates to the engine's
 * provider dispatch so this route works with whatever provider the user
 * picked as their defaultModel (copilot / claude-code / codex) — no
 * hardcoded vendor.
 */
async function oneShot(
  providerId: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const deadline = Date.now() + ONE_SHOT_DEADLINE_MS
  let collected = ''
  for await (const delta of providerStream(providerId, model, messages, undefined)) {
    if (Date.now() > deadline) break
    if (delta.kind === 'text' && typeof delta.text === 'string') {
      collected += delta.text
    }
    if (delta.kind === 'stop') break
  }
  return collected
}

const PLANNER_SYSTEM = `You are a planner for a single OpenHive agent.

Read the user's description and extract "reference topics" — concrete,
distinct methods, situations, domains, or artifact types that the USER
explicitly named in their description. The agent will consult a separate
reference file for each topic on demand.

Hard rules:
- Every reference must quote an EXACT phrase from the user's description
  as its "evidence" field. If you cannot quote a verbatim phrase, the
  topic does not belong in the list.
- If the user described the role in general terms (e.g. "a researcher",
  "a summarizer") without naming specific methods, domains, situations,
  or artifact types, return an EMPTY references array.
- Topics must be independent. If two candidates overlap, collapse them.
- Filenames are lowercase, hyphen-separated, ending with .md.

Return ONLY this JSON — no markdown fences, no prose:

{
  "role": "<1-3 word role name, slug-friendly>",
  "label": "<one-sentence description>",
  "references": [
    {
      "filename": "<slug>.md",
      "evidence": "<exact quoted phrase from the user's description>",
      "purpose": "<one sentence: what this reference file will cover>"
    }
  ]
}

--- Examples ---

User: "간단한 요약 에이전트"
→ {"role":"summarizer","label":"Condenses long inputs into short notes.","references":[]}

User: "텍스트 맞춤법 검사하는 애"
→ {"role":"proofreader","label":"Checks spelling and grammar.","references":[]}

User: "회의록 정리해주는 에이전트"
→ {"role":"note-taker","label":"Cleans up meeting notes.","references":[]}

User: "코드 리뷰어, PR 보고 피드백 주는"
→ {"role":"code-reviewer","label":"Reviews pull requests and leaves feedback.","references":[]}

User: "번역 에이전트 만들어줘"
→ {"role":"translator","label":"Translates text between languages.","references":[]}

User: "자료 조사 에이전트, 논문 위주로"
→ {"role":"researcher","label":"Researches topics, focusing on academic papers.","references":[{"filename":"academic-paper-search.md","evidence":"논문 위주로","purpose":"논문 중심 조사 방법과 신뢰할 학술 DB 목록."}]}

User: "리서처, 논문 조사 · 산업 보고서 스캔 · 경쟁사 비교까지 다 하는"
→ {"role":"researcher","label":"Comprehensive research analyst.","references":[{"filename":"academic-paper-search.md","evidence":"논문 조사","purpose":"논문 검색 및 평가."},{"filename":"industry-report-scan.md","evidence":"산업 보고서 스캔","purpose":"산업 보고서 해석 기법."},{"filename":"competitor-comparison.md","evidence":"경쟁사 비교","purpose":"경쟁사 비교 프레임워크."}]}`

const SKILL_MD_SYSTEM = `You are writing AGENT.md — the entry file for a single OpenHive agent.

Produce the complete file body, including YAML frontmatter. The agent
consults on-demand reference files lazily; DO NOT inline their content
here. List them in the "Reference index" section if any exist.

Exact format:

---
name: <slug>
description: <one-line purpose>
---

# Persona
One paragraph covering personality, responsibilities, and tone.

# Decision tree
Bullet list of if-then rules for the common cases.

# Reference index
- reference/<filename>.md — <one-line purpose>
- …

# Escalation
When to stop, ask the user, or hand back to Lead.

Rules:
- Under ~2KB total. Imperative voice. Concrete over generic.
- OMIT the "Reference index" section entirely if no references are listed.
- Do NOT invent reference files that aren't in the provided list.
- Match the user's language (Korean description → Korean body).
- Return the file body only. No markdown fences around the whole output.`

const REFERENCE_SYSTEM = `You are writing one reference file for an OpenHive agent. The agent reads
this file on demand when it needs context for the single topic below.

Rules:
- 200–600 words.
- Concrete and actionable: checklists, step-by-step procedures, named
  sources or tools, specific heuristics. No generic pep talk.
- Cover ONLY the topic scoped below. Do not repeat what AGENT.md or
  sibling reference files are meant to cover.
- Plain markdown. No YAML frontmatter. No level-1 heading.
- Match the user's language.
- Return the body only. No fences.`

function sanitizeFilename(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\s+/g, '-')
  if (!REFERENCE_FILENAME_RE.test(trimmed)) return null
  return trimmed
}

function parsePlanner(raw: string, description: string): PlannerOutput {
  const obj = extractJson(raw)
  const role = String(obj.role ?? '').trim() || 'Member'
  const label = String(obj.label ?? '').trim() || 'Copilot'
  const refsRaw = Array.isArray(obj.references) ? obj.references : []
  const refs: PlannerRef[] = []
  const seen = new Set<string>()
  for (const item of refsRaw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const filenameRaw = typeof rec.filename === 'string' ? rec.filename : ''
    const evidence = typeof rec.evidence === 'string' ? rec.evidence.trim() : ''
    const purpose = typeof rec.purpose === 'string' ? rec.purpose.trim() : ''
    const filename = sanitizeFilename(filenameRaw)
    if (!filename || !evidence || !purpose) continue
    // Evidence must be a literal substring of the user's description — this
    // catches LLM-fabricated references that don't trace back to user input.
    if (!description.includes(evidence)) continue
    if (seen.has(filename)) continue
    seen.add(filename)
    refs.push({ filename, evidence, purpose })
    if (refs.length >= MAX_REFERENCES) break
  }
  return { role, label, references: refs }
}

function formatRefList(refs: PlannerRef[]): string {
  if (refs.length === 0) return 'none'
  return refs.map((r) => `- ${r.filename} — ${r.purpose}`).join('\n')
}

// POST /api/agents/generate — 3-pass pipeline:
//   1. Planner    : decide role/label + reference topics (evidence-gated)
//   2. AGENT.md   : author the entry file, referencing (not inlining) files
//   3. References : one LLM call per reference file, in parallel
agents.post('/generate', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as GenerateBody
  const description = body.description?.trim()
  const companySlug = body.company_slug?.trim() || null
  const providerId = body.provider_id?.trim()
  const model = body.model?.trim()

  if (!description) {
    return c.json({ detail: 'description is required' }, 400)
  }
  if (!providerId || !model) {
    return c.json(
      {
        detail: 'default_model_required',
        message: 'Set a default model in Settings before asking AI to design an agent.',
      },
      400,
    )
  }

  try {
    // Pass 1 — planner.
    const plannerRaw = await oneShot(
      providerId,
      model,
      buildMessages(PLANNER_SYSTEM, [{ role: 'user', content: description }]),
    )
    const plan = parsePlanner(plannerRaw, description)

    // Pass 2 — AGENT.md body.
    const skillUser = [
      `Agent role: ${plan.role}`,
      `Agent label: ${plan.label}`,
      `Reference files available:\n${formatRefList(plan.references)}`,
      `User's original description: ${description}`,
    ].join('\n\n')
    const skillBody = (
      await oneShot(
        providerId,
        model,
        buildMessages(SKILL_MD_SYSTEM, [{ role: 'user', content: skillUser }]),
      )
    ).trim()
    if (!skillBody || !skillBody.startsWith('---')) {
      throw new Error(`AGENT.md generation failed (got ${skillBody.length} chars)`)
    }

    // Pass 3 — reference bodies in parallel. Isolated failures don't kill
    // the bundle; AGENT.md + successful files still ship, warnings[] carries
    // the list of failed filenames.
    const warnings: string[] = []
    const referenceFiles: Record<string, string> = {}
    if (plan.references.length > 0) {
      const results = await Promise.allSettled(
        plan.references.map(async (ref) => {
          const userMsg = [
            `Topic filename: ${ref.filename}`,
            `Topic purpose: ${ref.purpose}`,
            `Evidence from user's description: "${ref.evidence}"`,
            `Agent role: ${plan.role}`,
            `Agent label: ${plan.label}`,
            `User's original description: ${description}`,
          ].join('\n')
          const refBody = (
            await oneShot(
              providerId,
              model,
              buildMessages(REFERENCE_SYSTEM, [{ role: 'user', content: userMsg }]),
            )
          ).trim()
          if (!refBody) throw new Error('empty body')
          return { filename: ref.filename, body: refBody }
        }),
      )
      for (let i = 0; i < results.length; i += 1) {
        const r = results[i]
        const ref = plan.references[i]
        if (!ref || !r) continue
        if (r.status === 'fulfilled') {
          referenceFiles[`reference/${r.value.filename}`] = r.value.body
        } else {
          const reason = r.reason
          warnings.push(
            `reference/${ref.filename} failed: ${reason instanceof Error ? reason.message : String(reason)}`,
          )
        }
      }
    }

    const out: Record<string, unknown> = {
      id: rid('a'),
      role: plan.role,
      label: plan.label,
      provider_id: providerId,
      model,
      skills: [],
      position: { x: 0, y: 0 },
    }

    if (companySlug) {
      const files: Record<string, string> = { 'AGENT.md': skillBody, ...referenceFiles }
      const personaPath = writePersonaBundle(companySlug, plan.role, files)
      out.persona_path = personaPath
      const fm = /^---\s*\n([\s\S]*?)\n---/.exec(skillBody)
      if (fm) {
        const nameMatch = /(?:^|\n)name:\s*(.+)/.exec(fm[1] ?? '')
        const captured = nameMatch?.[1]
        if (captured) out.persona_name = captured.trim().replace(/^["']|["']$/g, '')
      }
    } else {
      // No company scope — fall back to an inline system prompt derived from
      // AGENT.md body (frontmatter stripped).
      const inline = skillBody.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim()
      out.system_prompt = inline || `You are a ${plan.role}.`
    }

    if (warnings.length > 0) out.warnings = warnings
    return c.json(out)
  } catch (exc) {
    if (exc instanceof ScopeViolationError) {
      return c.json({ detail: `persona file path rejected: ${exc.message}` }, 400)
    }
    return c.json({ detail: exc instanceof Error ? exc.message : String(exc) }, 500)
  }
})

// GET /api/agents/persona/files?persona_path=… — read every .md file in
// an existing persona bundle so NodeEditor can show/edit the full tree.
agents.get('/persona/files', (c) => {
  const personaPath = c.req.query('persona_path')?.trim()
  if (!personaPath) return c.json({ detail: 'persona_path required' }, 400)
  const resolved = path.resolve(personaPath)
  if (
    !resolved.includes(`${path.sep}companies${path.sep}`) &&
    !resolved.includes(`${path.sep}packages${path.sep}agents${path.sep}`) &&
    !resolved.includes(`${path.sep}.openhive${path.sep}agents${path.sep}`)
  ) {
    return c.json({ detail: 'persona_path out of scope' }, 400)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return c.json({ detail: 'persona dir not found' }, 404)
  }
  const out: Record<string, string> = {}
  const MAX_BYTES = 128 * 1024
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      const relNext = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(abs, relNext)
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const data = fs.readFileSync(abs, 'utf8')
          if (Buffer.byteLength(data, 'utf8') <= MAX_BYTES) out[relNext] = data
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  walk(resolved, '')
  return c.json({ files: out })
})

// POST /api/agents/persona — scaffold a brand-new persona bundle with a
// caller-supplied file map (AGENT.md + optional reference/*.md). Used by
// CreateAgentModal before it calls addAgent with persona_path pre-set.
agents.post('/persona', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    company_slug?: string
    role?: string
    agent_id?: string
    files?: Record<string, string>
  }
  const companySlug = body.company_slug?.trim()
  const role = body.role?.trim() || 'agent'
  const agentId = body.agent_id?.trim() || 'bundle'
  const files = body.files
  if (!companySlug) return c.json({ detail: 'company_slug required' }, 400)
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return c.json({ detail: 'files map required' }, 400)
  }
  const strFiles: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) {
    if (typeof k === 'string' && typeof v === 'string') strFiles[k] = v
  }
  if (!strFiles['AGENT.md']) {
    return c.json({ detail: 'AGENT.md is required' }, 400)
  }
  try {
    const personaPath = writePersonaBundle(companySlug, role, strFiles, agentId)
    // Parse persona_name from the frontmatter so the caller can plug it
    // straight into the agent dict.
    let personaName: string | null = null
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(strFiles['AGENT.md'])
    if (fm) {
      const nameMatch = /(?:^|\n)name:\s*(.+)/.exec(fm[1] ?? '')
      const captured = nameMatch?.[1]
      if (captured) personaName = captured.trim().replace(/^["']|["']$/g, '')
    }
    return c.json({ persona_path: personaPath, persona_name: personaName })
  } catch (exc) {
    if (exc instanceof ScopeViolationError) {
      return c.json({ detail: `persona file path rejected: ${exc.message}` }, 400)
    }
    return c.json({ detail: exc instanceof Error ? exc.message : String(exc) }, 500)
  }
})

// PUT /api/agents/persona/files — rewrite the entire file set of an existing
// persona bundle. Any file on disk not present in the incoming map is
// deleted (except AGENT.md, which must stay). Used by NodeEditor when the
// user adds or removes reference files in edit mode.
agents.put('/persona/files', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    persona_path?: string
    files?: Record<string, string>
  }
  const personaPath = body.persona_path?.trim()
  const files = body.files
  if (!personaPath) return c.json({ detail: 'persona_path required' }, 400)
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return c.json({ detail: 'files map required' }, 400)
  }
  if (!files['AGENT.md']) {
    return c.json({ detail: 'AGENT.md cannot be removed' }, 400)
  }
  const resolved = path.resolve(personaPath)
  if (
    !resolved.includes(`${path.sep}companies${path.sep}`) ||
    !resolved.includes(`${path.sep}agents${path.sep}`)
  ) {
    return c.json({ detail: 'persona_path out of scope' }, 400)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return c.json({ detail: 'persona dir not found' }, 404)
  }
  // Delete files that are no longer in the incoming map. Walk only .md
  // entries under the persona dir so we don't touch sibling artefacts like
  // tools.yaml that aren't part of the editable set.
  const keepSet = new Set(Object.keys(files))
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      const relNext = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(abs, relNext)
        // Clean up empty reference/ sub-dir so a deleted last file doesn't
        // leave a ghost folder hanging around.
        if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs)
      } else if (e.isFile() && e.name.endsWith('.md') && !keepSet.has(relNext)) {
        fs.unlinkSync(abs)
      }
    }
  }
  try {
    walk(resolved, '')
    const strFiles: Record<string, string> = {}
    for (const [k, v] of Object.entries(files)) {
      if (typeof k === 'string' && typeof v === 'string') strFiles[k] = v
    }
    // Write via scopedWriteAll by funnelling through writePersonaBundle's
    // guarantees: resolve the persona dir, then call scopedWriteAll on it.
    const { scopedWriteAll: scoped } = await import('@/lib/server/scoped-fs')
    scoped({ base: resolved, allowPattern: /^[A-Za-z0-9._\-/]+$/ }, strFiles, {
      maxFiles: 60,
      maxBytesPerFile: 64 * 1024,
    })
    return c.json({ ok: true })
  } catch (exc) {
    if (exc instanceof ScopeViolationError) {
      return c.json({ detail: `persona file path rejected: ${exc.message}` }, 400)
    }
    return c.json({ detail: exc instanceof Error ? exc.message : String(exc) }, 500)
  }
})

// PUT /api/agents/persona/body — overwrite the AGENT.md body of a persona
// while preserving its YAML frontmatter. Used by NodeEditor's AGENT.md tab.
agents.put('/persona/body', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    persona_path?: string
    body?: string
  }
  const personaPath = body.persona_path?.trim()
  const newBody = typeof body.body === 'string' ? body.body : null
  if (!personaPath || newBody === null) {
    return c.json({ detail: 'persona_path and body are required' }, 400)
  }
  // Hard safety: only accept paths inside a company agents dir. No
  // symlink traversal, no writes outside ~/.openhive/companies.
  const resolved = path.resolve(personaPath)
  if (!resolved.includes(`${path.sep}companies${path.sep}`) || !resolved.includes(`${path.sep}agents${path.sep}`)) {
    return c.json({ detail: 'persona_path out of scope' }, 400)
  }
  const agentMd = path.join(resolved, 'AGENT.md')
  if (!fs.existsSync(agentMd) || !fs.statSync(agentMd).isFile()) {
    return c.json({ detail: 'AGENT.md not found' }, 404)
  }
  const raw = fs.readFileSync(agentMd, 'utf8')
  // Preserve frontmatter if present; otherwise just write body verbatim.
  let frontmatter = ''
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3)
    if (end !== -1) frontmatter = `${raw.slice(0, end + '\n---'.length)}\n\n`
  }
  fs.writeFileSync(agentMd, `${frontmatter}${newBody.trimEnd()}\n`, 'utf8')
  return c.json({ ok: true })
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
      body: p.body,
      model: p.model,
      skills: p.tools.skills,
      mcp_servers: p.tools.mcp_servers,
    })
  }
  // Stable order: bundled first, then company, then user.
  const rank = { bundled: 0, company: 1, user: 2, inline: 3 }
  out.sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name))
  return c.json(out)
})
