import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TOOL_ROUNDS_PER_TURN,
  ensureTeamLimits,
} from './scaffold'

describe('ensureTeamLimits', () => {
  it('bumps legacy 8-round default to new default', () => {
    const team: Record<string, unknown> = {
      limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
    }
    const changed = ensureTeamLimits(team)
    expect(changed).toBe(true)
    expect((team.limits as { max_tool_rounds_per_turn: number }).max_tool_rounds_per_turn).toBe(
      DEFAULT_MAX_TOOL_ROUNDS_PER_TURN,
    )
  })

  it('leaves a value ≥ default alone (user-tuned teams unaffected)', () => {
    const team: Record<string, unknown> = {
      limits: { max_tool_rounds_per_turn: 48, max_delegation_depth: 4 },
    }
    expect(ensureTeamLimits(team)).toBe(false)
    expect((team.limits as { max_tool_rounds_per_turn: number }).max_tool_rounds_per_turn).toBe(48)
  })

  it('is idempotent — second call is a no-op', () => {
    const team: Record<string, unknown> = {
      limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
    }
    expect(ensureTeamLimits(team)).toBe(true)
    expect(ensureTeamLimits(team)).toBe(false)
  })

  it('creates limits when missing entirely', () => {
    const team: Record<string, unknown> = {}
    expect(ensureTeamLimits(team)).toBe(true)
    expect(team.limits).toEqual({
      max_tool_rounds_per_turn: DEFAULT_MAX_TOOL_ROUNDS_PER_TURN,
      max_delegation_depth: 4,
    })
  })

  it('preserves max_delegation_depth on teams that already set it', () => {
    const team: Record<string, unknown> = {
      limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 6 },
    }
    ensureTeamLimits(team)
    expect((team.limits as { max_delegation_depth: number }).max_delegation_depth).toBe(6)
  })

  it('does not touch agents / edges / other top-level fields', () => {
    const team: Record<string, unknown> = {
      id: 't-abc',
      agents: [{ id: 'a-1' }],
      edges: [],
      limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
    }
    ensureTeamLimits(team)
    expect(team.id).toBe('t-abc')
    expect(team.agents).toHaveLength(1)
    expect(team.edges).toEqual([])
  })
})
