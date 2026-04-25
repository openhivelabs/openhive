import { describe, it, expect } from 'vitest'
import { askUserGuidance, delegateToGuidance, activateSkillGuidance } from './delegation-guidance'
import { buildRelaySection, parallelDelegationRule } from './session'
import type { TeamSpec } from './team'

const teamFixture: TeamSpec = {
  id: 'team-x',
  name: 'Test',
  agents: [],
  edges: [],
  entry_agent_id: null,
  allowed_skills: [],
  allowed_mcp_servers: [],
  limits: {
    max_tool_rounds_per_turn: 8,
    max_delegation_depth: 4,
    max_delegations_per_pair_per_turn: 4,
    max_ask_user_per_turn: 4,
    max_read_skill_file_per_turn: 8,
    max_web_search_per_turn: 5,
  },
}

describe('askUserGuidance', () => {
  const g = askUserGuidance()

  it('states LAST RESORT framing', () => {
    expect(g).toMatch(/LAST RESORT/)
  })

  it('lists 4-part precheck including no-chaining', () => {
    expect(g).toMatch(/INCOMPATIBLE/)
    expect(g).toMatch(/never chain/i)
  })

  it('lists NOT-reasons (greetings / tone / defaults)', () => {
    expect(g).toMatch(/greeting/i)
    expect(g).toMatch(/tone|register/i)
    expect(g).toMatch(/default format/i)
  })

  it('explicitly forbids asking about deliverable / document output language', () => {
    expect(g).toMatch(/document output language|deliverable.*language/i)
    // Regresses if someone collapses back to the one-liner "default formats".
    expect(g).toMatch(/default to the user's conversation language/i)
  })

  it('explicitly forbids asking about deliverable tone (존댓말/반말)', () => {
    expect(g).toMatch(/document tone|deliverable.*tone/i)
    expect(g).toMatch(/한국어\(존댓말\).*한국어\(반말\)/)
  })

  it('lists enumerable branching as NOT-reason with example', () => {
    expect(g).toMatch(/enumerable branching|state your interpretation/i)
  })

  it('bundles questions into one call', () => {
    expect(g).toMatch(/bundle.*ONE call|ONE call/i)
  })

  it('defers to system prompt for full policy (stays terse)', () => {
    expect(g).toMatch(/system prompt/i)
  })
})

describe('delegateToGuidance', () => {
  const g = delegateToGuidance()

  it('mentions briefing 4-part discipline', () => {
    expect(g).toMatch(/\*\*Goal\*\*/)
    expect(g).toMatch(/\*\*Context\*\*/)
    expect(g).toMatch(/\*\*Deliverable\*\*/)
    expect(g).toMatch(/\*\*Scope fence\*\*/)
  })

  it('forbids delegating understanding', () => {
    expect(g).toMatch(/Never delegate understanding/i)
  })

  it('describes multiple-calls parallel pattern', () => {
    expect(g).toMatch(/MULTIPLE times/i)
    expect(g).toMatch(/parallel|concurrently|fan out/i)
  })

  it('requires the three-valued mode param (research/verify/produce)', () => {
    expect(g).toMatch(/research/)
    expect(g).toMatch(/verify/)
    expect(g).toMatch(/produce/)
  })

  it('states research/verify cannot leak files to user', () => {
    // Enforced by engine (scratch dir routing), but the tool description
    // must surface the contract so the Lead picks mode deliberately.
    expect(g).toMatch(/scratch|private|hidden from user|CAN.?T (leak|create)/i)
  })

  it('locks "one file per produce delegation"', () => {
    expect(g).toMatch(/one file per produce delegation/i)
  })
})

describe('parallelDelegationRule (shared fan-out helper)', () => {
  it('mentions delegate_parallel and independent subtasks', () => {
    const r = parallelDelegationRule({ isLead: true })
    expect(r).toMatch(/delegate_parallel/)
    expect(r).toMatch(/independent subtasks/i)
    expect(r).toMatch(/MULTIPLE/)
  })
})

describe('buildRelaySection — parallel fan-out injection', () => {
  it('includes parallel rule for the Lead branch (regression)', () => {
    const out = buildRelaySection(0, true, teamFixture)
    expect(out).toMatch(/Parallel fan-out/)
    expect(out).toMatch(/delegate_parallel/)
    expect(out).toMatch(/independent subtasks/i)
  })

  it('includes parallel rule for a non-Lead manager that has subordinates', () => {
    const out = buildRelaySection(1, true, teamFixture)
    expect(out).toMatch(/Parallel fan-out/)
    expect(out).toMatch(/delegate_parallel/)
    expect(out).toMatch(/independent subtasks/i)
  })

  it('omits parallel rule for a non-Lead leaf agent (no subs)', () => {
    const out = buildRelaySection(1, false, teamFixture)
    expect(out).not.toMatch(/Parallel fan-out/)
    expect(out).not.toMatch(/delegate_parallel/)
  })
})

describe('activateSkillGuidance', () => {
  const g = activateSkillGuidance()

  it('describes load-guide + lazy activation', () => {
    expect(g).toMatch(/SKILL\.md|guide/i)
    expect(g).toMatch(/lazy|only when/i)
  })
})
