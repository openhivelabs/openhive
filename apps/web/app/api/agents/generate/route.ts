import { NextResponse } from 'next/server'
import { extractJson, loadSkillBody, rid } from '@/lib/server/ai-generators/common'
import { chatCompletion } from '@/lib/server/providers/copilot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const AGENT_CREATOR_SKILL = loadSkillBody('agent-creator')

const OUTPUT_DIRECTIVE = `You are OpenHive's single-agent designer. Use the \`agent-creator\` guidance
above as reference for what makes a good agent persona, but for THIS call
you are NOT scaffolding a directory — you are generating an inline agent
spec for the canvas.

Given a short description of the role the user wants to add, return ONLY a
JSON object matching this schema (no prose, no markdown fences):

\`\`\`json
{
  "role": "<short role name, 1-3 words — Researcher, Writer, Analyst, etc.>",
  "label": "<one-sentence description of what this agent does>",
  "system_prompt": "<2-4 sentences in imperative voice — what the agent does, how to report back>",
  "skills": ["<optional list of skill names the agent should have>"]
}
\`\`\`

Rules:
- \`role\` is a descriptive single or compound word. Avoid fake C-suite titles.
- \`system_prompt\` is concrete and directive — no fluff, no "you are helpful".
- \`skills\` may be an empty list. Only include skills the user clearly implied.
- Return nothing except the JSON object.`

interface Body {
  description?: string
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body
  const description = body.description?.trim()
  if (!description) {
    return NextResponse.json({ detail: 'description is required' }, { status: 400 })
  }
  try {
    const text = await chatCompletion({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: `${AGENT_CREATOR_SKILL}\n\n---\n\n${OUTPUT_DIRECTIVE}` },
        { role: 'user', content: description },
      ],
      temperature: 0.4,
    })
    const meta = extractJson(text)
    const role = String(meta.role ?? '').trim() || 'Member'
    const label = String(meta.label ?? '').trim() || 'Copilot'
    const systemPrompt =
      String(meta.system_prompt ?? '').trim() || `You are a ${role}.`
    const skills = Array.isArray(meta.skills)
      ? meta.skills.map(String).map((s) => s.trim()).filter(Boolean)
      : []
    return NextResponse.json({
      id: rid('a'),
      role,
      label,
      provider_id: 'copilot',
      model: 'gpt-5-mini',
      system_prompt: systemPrompt,
      skills,
      position: { x: 0, y: 0 },
    })
  } catch (exc) {
    return NextResponse.json(
      { detail: exc instanceof Error ? exc.message : String(exc) },
      { status: 500 },
    )
  }
}
