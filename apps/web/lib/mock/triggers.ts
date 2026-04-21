import type { Trigger } from '../types'

export const mockTriggers: Trigger[] = [
  {
    id: 'tr1',
    kind: 'cron',
    teamId: 't1',
    label: 'Weekly market report',
    config: { schedule: '0 9 * * MON', goal: 'Compile the weekly semiconductor market brief.' },
    enabled: true,
  },
  {
    id: 'tr2',
    kind: 'webhook',
    teamId: 't1',
    label: 'GitHub PR opened',
    config: { path: '/webhook/report-team/gh-pr' },
    enabled: false,
  },
  {
    id: 'tr3',
    kind: 'file_watch',
    teamId: 't2',
    label: 'Inbox PDF drop',
    config: { directory: '~/openhive-inbox/rnd', pattern: '*.pdf' },
    enabled: true,
  },
]
