/**
 * Provider registry. Ports apps/server/openhive/auth/providers.py.
 * Static metadata — flow implementations live in ./claude, ./codex, ./copilot.
 */

export type FlowKind = 'auth_code' | 'device_code'

export interface ProviderDef {
  id: string
  label: string
  kind: FlowKind
  description: string
}

/** Display order in the UI. */
export const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'auth_code',
    description:
      'Use your Claude Code subscription to power agents with Claude models.',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    kind: 'auth_code',
    description:
      'Use your Codex (ChatGPT) subscription for agents running on GPT models.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    kind: 'device_code',
    description:
      'Use your GitHub Copilot subscription. Activates via device-code login.',
  },
]

const BY_ID = new Map<string, ProviderDef>(PROVIDERS.map((p) => [p.id, p]))

export function getProvider(id: string): ProviderDef | null {
  return BY_ID.get(id) ?? null
}
