import { NextResponse } from 'next/server'
import { saveTeam } from '@/lib/server/companies'
import {
  extractJson,
  loadSkillBody,
  rid,
  slugify,
} from '@/lib/server/ai-generators/common'
import { chatCompletion } from '@/lib/server/providers/copilot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const META_SYSTEM_PROMPT = loadSkillBody('design-team')

interface Body {
  description?: string
  company_slug?: string
}

interface AgentLike {
  role?: unknown
  system_prompt?: unknown
}

interface EdgeLike {
  from?: unknown
  to?: unknown
}

function layoutPositions(nMembers: number): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [{ x: 400, y: 40 }]
  if (nMembers === 0) return positions
  const spacing = 260
  const totalWidth = nMembers > 1 ? spacing * (nMembers - 1) : 0
  const startX = 400 - totalWidth / 2
  for (let i = 0; i < nMembers; i += 1) {
    positions.push({ x: startX + i * spacing, y: 240 })
  }
  return positions
}

function buildTeamYaml(
  meta: Record<string, unknown>,
  description: string,
): Record<string, unknown> {
  const name =
    typeof meta.name === 'string' && meta.name
      ? meta.name
      : description.slice(0, 40) || 'New team'
  const agentsRaw = Array.isArray(meta.agents) ? (meta.agents as AgentLike[]) : []
  const edgesRaw = Array.isArray(meta.edges) ? (meta.edges as EdgeLike[]) : []
  if (agentsRaw.length === 0) throw new Error('meta-agent returned no agents')

  const roleToId = new Map<string, string>()
  const agents: Record<string, unknown>[] = []
  let leadCount = 0
  for (const a of agentsRaw) {
    const role = String(a.role ?? '').trim() || 'Member'
    if (role === 'Lead') leadCount += 1
    const aid = rid('a')
    roleToId.set(role, aid)
    agents.push({
      id: aid,
      role,
      label: 'Copilot',
      provider_id: 'copilot',
      model: 'gpt-5-mini',
      system_prompt:
        typeof a.system_prompt === 'string' && a.system_prompt
          ? a.system_prompt
          : `You are a ${role}.`,
      skills: [],
      position: { x: 0, y: 0 },
    })
  }
  if (leadCount !== 1) {
    throw new Error(`meta-agent returned ${leadCount} Leads (expected 1)`)
  }

  const lead = agents.find((a) => a.role === 'Lead')!
  const members = agents.filter((a) => a !== lead)
  const ordered = [lead, ...members]
  const positions = layoutPositions(members.length)
  ordered.forEach((a, i) => {
    a.position = positions[i]!
  })

  const edges: Record<string, unknown>[] = []
  for (const e of edgesRaw) {
    const src = roleToId.get(String(e.from ?? '').trim())
    const tgt = roleToId.get(String(e.to ?? '').trim())
    if (!src || !tgt || src === tgt) continue
    edges.push({ id: rid('e'), source: src, target: tgt })
  }
  if (edges.length === 0) {
    const leadId = lead.id as string
    for (const m of members) {
      edges.push({ id: rid('e'), source: leadId, target: m.id as string })
    }
  }

  return {
    id: rid('t'),
    slug: slugify(name),
    name,
    agents: ordered,
    edges,
    entry_agent_id: null,
    allowed_skills: [],
    limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
  }
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body
  const description = body.description?.trim()
  if (!description) {
    return NextResponse.json({ detail: 'description is required' }, { status: 400 })
  }
  if (typeof body.company_slug !== 'string' || !body.company_slug) {
    return NextResponse.json({ detail: 'company_slug required' }, { status: 400 })
  }
  try {
    const text = await chatCompletion({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: META_SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
      temperature: 0.4,
    })
    const meta = extractJson(text)
    const team = buildTeamYaml(meta, description)
    saveTeam(body.company_slug, team)
    return NextResponse.json(team)
  } catch (exc) {
    return NextResponse.json(
      { detail: exc instanceof Error ? exc.message : String(exc) },
      { status: 500 },
    )
  }
}
