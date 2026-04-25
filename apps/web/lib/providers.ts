import type { Provider } from './types'

/**
 * Built-in provider catalog. IDs match the OAuth provider IDs used by the
 * backend (`apps/server/openhive/auth/providers.py`).
 */
export const PROVIDERS: Provider[] = [
  { id: 'claude-code', kind: 'oauth', label: 'Claude Code', connected: false },
  { id: 'codex', kind: 'oauth', label: 'Codex', connected: false },
  { id: 'copilot', kind: 'oauth', label: 'Copilot', connected: false },
]
