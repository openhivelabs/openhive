import type { Message } from '../types'

export const mockMessages: Message[] = [
  {
    id: 'm1',
    teamId: 't1',
    from: 'user',
    text: 'Please write a one-page market report on semiconductor trends.',
    createdAt: '2026-04-19T09:00:00Z',
  },
  {
    id: 'm2',
    teamId: 't1',
    from: 'a1',
    text: 'Got it. Researcher, please gather market size and top vendors. Writer, draft the outline in parallel.',
    createdAt: '2026-04-19T09:00:12Z',
  },
  {
    id: 'm3',
    teamId: 't1',
    from: 'a2',
    text: 'Research complete: HBM market grew 43% YoY, led by SK hynix, Samsung, Micron.',
    createdAt: '2026-04-19T09:02:40Z',
  },
  {
    id: 'm4',
    teamId: 't2',
    from: 'user',
    text: 'Summarize the latest arXiv papers on 2nm GAA transistors.',
    createdAt: '2026-04-19T10:15:00Z',
  },
  {
    id: 'm5',
    teamId: 't2',
    from: 'b3',
    text: 'Engineers — take the top 5 papers each and extract the performance claims.',
    createdAt: '2026-04-19T10:15:08Z',
  },
]
