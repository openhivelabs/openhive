import type { Team } from './types'

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export interface PresetDef {
  id: string
  name: string
  tagline: string
  icon: string
  build: () => Team
}

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function buildReportTeam(): Team {
  const ceo = makeId('a')
  const research = makeId('a')
  const writer = makeId('a')
  const reviewer = makeId('a')
  return {
    id: makeId('t'),
    slug: slug(`report-team-${Date.now()}`),
    name: 'Report Team',
    agents: [
      {
        id: ceo,
        role: 'Lead',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You lead the team. Delegate research, writing, and review.',
        skills: [],
        position: { x: 400, y: 40 },
      },
      {
        id: research,
        role: 'Researcher',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You gather relevant facts and sources.',
        skills: ['web-research'],
        position: { x: 200, y: 240 },
      },
      {
        id: writer,
        role: 'Writer',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You turn research into a polished document.',
        skills: ['docx-writer'],
        position: { x: 600, y: 240 },
      },
      {
        id: reviewer,
        role: 'Reviewer',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You review the draft and flag issues.',
        skills: [],
        position: { x: 400, y: 440 },
      },
    ],
    edges: [
      { id: makeId('e'), source: ceo, target: research },
      { id: makeId('e'), source: ceo, target: writer },
      { id: makeId('e'), source: writer, target: reviewer },
      { id: makeId('e'), source: research, target: writer },
    ],
  }
}

function buildRndTeam(): Team {
  const lead = makeId('a')
  const eng1 = makeId('a')
  const eng2 = makeId('a')
  const scientist = makeId('a')
  return {
    id: makeId('t'),
    slug: slug(`rnd-team-${Date.now()}`),
    name: 'R&D Team',
    agents: [
      {
        id: lead,
        role: 'Lead',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You lead the R&D team. Delegate experiments and implementation.',
        skills: [],
        position: { x: 400, y: 40 },
      },
      {
        id: scientist,
        role: 'Scientist',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You design experiments and analyze results.',
        skills: ['python-runner'],
        position: { x: 150, y: 240 },
      },
      {
        id: eng1,
        role: 'Engineer',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You implement prototypes.',
        skills: ['python-runner'],
        position: { x: 400, y: 240 },
      },
      {
        id: eng2,
        role: 'Engineer',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You implement prototypes.',
        skills: ['python-runner'],
        position: { x: 650, y: 240 },
      },
    ],
    edges: [
      { id: makeId('e'), source: lead, target: scientist },
      { id: makeId('e'), source: lead, target: eng1 },
      { id: makeId('e'), source: lead, target: eng2 },
    ],
  }
}

function buildCodeReviewTeam(): Team {
  const lead = makeId('a')
  const r1 = makeId('a')
  const r2 = makeId('a')
  const security = makeId('a')
  return {
    id: makeId('t'),
    slug: slug(`code-review-${Date.now()}`),
    name: 'Code Review Team',
    agents: [
      {
        id: lead,
        role: 'Lead',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'You lead the review effort. Split the PR by concerns and delegate.',
        skills: [],
        position: { x: 400, y: 40 },
      },
      {
        id: r1,
        role: 'Reviewer',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'Check correctness and tests.',
        skills: [],
        position: { x: 200, y: 240 },
      },
      {
        id: r2,
        role: 'Reviewer',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'Check style, readability, and docs.',
        skills: [],
        position: { x: 600, y: 240 },
      },
      {
        id: security,
        role: 'Reviewer',
        label: 'Copilot',
        providerId: 'copilot',
        model: 'gpt-5-mini',
        systemPrompt: 'Look for vulnerabilities and unsafe patterns.',
        skills: [],
        position: { x: 400, y: 440 },
      },
    ],
    edges: [
      { id: makeId('e'), source: lead, target: r1 },
      { id: makeId('e'), source: lead, target: r2 },
      { id: makeId('e'), source: lead, target: security },
    ],
  }
}

export const PRESETS: PresetDef[] = [
  {
    id: 'report-team',
    name: 'Report Team',
    tagline: 'Research → Write → Review. Great for market reports and briefings.',
    icon: '📊',
    build: buildReportTeam,
  },
  {
    id: 'rnd-team',
    name: 'R&D Team',
    tagline: 'Science + engineering hierarchy for experiments and prototypes.',
    icon: '🧪',
    build: buildRndTeam,
  },
  {
    id: 'code-review',
    name: 'Code Review Team',
    tagline: 'Correctness, style, and security reviewers in parallel.',
    icon: '🔍',
    build: buildCodeReviewTeam,
  },
]

/**
 * Stubbed natural-language builder. In Phase 7 this calls a meta-agent on the backend.
 * For now it returns the R&D template for anything mentioning research/r&d, and Report
 * Team otherwise.
 */
export function buildTeamFromNaturalLanguage(prompt: string): Team {
  const p = prompt.toLowerCase()
  if (p.includes('r&d') || p.includes('research') || p.includes('semiconductor')) {
    const t = buildRndTeam()
    return { ...t, name: prompt.slice(0, 40) || t.name }
  }
  if (p.includes('review') || p.includes('code')) {
    const t = buildCodeReviewTeam()
    return { ...t, name: prompt.slice(0, 40) || t.name }
  }
  const t = buildReportTeam()
  return { ...t, name: prompt.slice(0, 40) || t.name }
}
