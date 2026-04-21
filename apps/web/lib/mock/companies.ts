import type { Company, Provider } from '../types'

/**
 * These IDs match the OAuth provider IDs used by the backend
 * (`apps/server/openhive/auth/providers.py`).
 */
export const mockProviders: Provider[] = [
  { id: 'claude-code', kind: 'oauth', label: 'Claude Code', connected: false },
  { id: 'codex', kind: 'oauth', label: 'Codex', connected: false },
  { id: 'copilot', kind: 'oauth', label: 'Copilot', connected: false },
]

export const mockCompanies: Company[] = [
  {
    id: 'c1',
    slug: 'acme',
    name: 'Acme Corp',
    teams: [
      {
        id: 't1',
        slug: 'report-team',
        name: 'Report Team',
        agents: [
          {
            id: 'a1',
            role: 'Lead',
            label: 'Copilot',
            providerId: 'copilot',
            model: 'gpt-5-mini',
            systemPrompt:
              'You lead the team. If the request is ambiguous or missing a concrete topic/scope/audience, call ask_user with 2-4 crisp options before delegating. Otherwise delegate to Researcher and Writer.',
            skills: [],
            position: { x: 400, y: 40 },
          },
          {
            id: 'a2',
            role: 'Researcher',
            label: 'Copilot',
            providerId: 'copilot',
            model: 'gpt-5-mini',
            systemPrompt: 'You research topics thoroughly.',
            skills: ['web-research'],
            position: { x: 200, y: 240 },
          },
          {
            id: 'a3',
            role: 'Writer',
            label: 'Copilot',
            providerId: 'copilot',
            model: 'gpt-5-mini',
            systemPrompt: 'You write polished final documents.',
            skills: ['docx-writer'],
            position: { x: 600, y: 240 },
          },
        ],
        edges: [
          { id: 'e1', source: 'a1', target: 'a2' },
          { id: 'e2', source: 'a1', target: 'a3' },
        ],
      },
    ],
  },
  {
    id: 'c2',
    slug: 'rnd-lab',
    name: 'R&D Lab',
    teams: [
      {
        id: 't2',
        slug: 'semi-research',
        name: 'Semiconductor Research',
        agents: [
          {
            id: 'b1',
            role: 'Lead',
            label: 'Claude Code',
            providerId: 'claude-code',
            model: 'claude-opus-4-7',
            systemPrompt: 'You lead the R&D team. Delegate research and implementation.',
            skills: [],
            position: { x: 400, y: 40 },
          },
          {
            id: 'b2',
            role: 'Researcher',
            label: 'Codex',
            providerId: 'codex',
            model: 'gpt-5.4',
            systemPrompt: 'You investigate prior art and literature.',
            skills: ['web-research'],
            position: { x: 150, y: 240 },
            isActive: true,
          },
          {
            id: 'b3',
            role: 'Engineer',
            label: 'Copilot',
            providerId: 'copilot',
            model: 'gpt-5-mini',
            systemPrompt: 'You implement prototypes.',
            skills: ['python-runner'],
            position: { x: 400, y: 240 },
          },
          {
            id: 'b4',
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
          { id: 'e3', source: 'b1', target: 'b2' },
          { id: 'e4', source: 'b1', target: 'b3' },
          { id: 'e5', source: 'b1', target: 'b4' },
        ],
      },
    ],
  },
]
