/**
 * Pre-run sanity checks.
 * Ports apps/server/openhive/engine/preflight.py.
 *
 * Catches obvious failures (missing OAuth token, bad provider, empty agent
 * list) BEFORE the engine starts so the user doesn't wait for the LLM call
 * to surface a cryptic 401 several seconds in.
 */

import { getProvider } from '../auth/providers'
import { listConnected } from '../tokens'
import { entryAgent, type TeamSpec } from './team'

export function validateTeam(team: TeamSpec): string[] {
  const errors: string[] = []
  if (team.agents.length === 0) {
    errors.push('Team has no agents.')
    return errors
  }

  const connected = new Set(listConnected())
  const seenProviders = new Set<string>()

  for (const agent of team.agents) {
    if (!agent.provider_id) {
      errors.push(
        `Agent '${agent.label || agent.role}' has no provider configured.`,
      )
      continue
    }
    if (seenProviders.has(agent.provider_id)) continue
    seenProviders.add(agent.provider_id)
    const provider = getProvider(agent.provider_id)
    if (!provider) {
      errors.push(`Unknown provider '${agent.provider_id}'.`)
      continue
    }
    if (!connected.has(agent.provider_id)) {
      errors.push(
        `Provider '${provider.label}' is not connected. ` +
          'Connect it in Settings → Providers before starting a run.',
      )
    }
  }

  for (const agent of team.agents) {
    if (!agent.model) {
      errors.push(
        `Agent '${agent.label || agent.role}' has no model selected.`,
      )
    }
  }

  try {
    entryAgent(team)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errors.push(`Could not determine entry agent: ${message}`)
  }

  return errors
}
