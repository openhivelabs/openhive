import type { Artifact } from '../types'

export const mockArtifacts: Artifact[] = [
  {
    id: 'ar1',
    teamId: 't1',
    runId: 'run-2026-04-18-0900',
    filename: 'semiconductor-weekly-2026-w16.pdf',
    path: '~/.openhive/artifacts/acme/report-team/run-2026-04-18-0900/semiconductor-weekly-2026-w16.pdf',
    mime: 'application/pdf',
    createdAt: '2026-04-18T09:45:00Z',
  },
  {
    id: 'ar2',
    teamId: 't1',
    runId: 'run-2026-04-18-0900',
    filename: 'research-notes.md',
    path: '~/.openhive/artifacts/acme/report-team/run-2026-04-18-0900/research-notes.md',
    mime: 'text/markdown',
    createdAt: '2026-04-18T09:22:00Z',
  },
  {
    id: 'ar3',
    teamId: 't2',
    runId: 'run-2026-04-19-1015',
    filename: 'gaa-transistor-summary.pptx',
    path: '~/.openhive/artifacts/rnd-lab/semi-research/run-2026-04-19-1015/gaa-transistor-summary.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    createdAt: '2026-04-19T10:38:00Z',
  },
]
