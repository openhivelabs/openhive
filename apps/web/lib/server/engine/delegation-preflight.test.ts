import { describe, expect, it } from 'vitest'
import {
  BUDGET_EXHAUSTED_RETRY_CAP,
  composeSystemPrompt,
  makeBudgetExhaustedResult,
  preflightDelegation,
} from './session'
import type { AgentSpec, TeamSpec } from './team'
import type { SkillDef } from '../skills/loader'

function fakeAgent(opts: Partial<AgentSpec> & { id: string; role: string }): AgentSpec {
  return {
    id: opts.id,
    role: opts.role,
    label: opts.label ?? opts.role,
    provider_id: opts.provider_id ?? 'codex',
    model: opts.model ?? 'gpt-5',
    system_prompt: opts.system_prompt ?? '',
    skills: opts.skills ?? [],
    max_parallel: opts.max_parallel ?? 1,
    persona_path: null,
    persona_name: null,
  }
}

function fakeTeam(agents: AgentSpec[], disabled: string[] = []): TeamSpec {
  return {
    id: 't-test',
    name: 'test',
    agents,
    edges: [],
    entry_agent_id: agents[0]?.id ?? null,
    allowed_skills: [],
    disabled_skills: disabled,
    allowed_mcp_servers: [],
    limits: {
      max_tool_rounds_per_turn: 24,
      max_delegation_depth: 4,
      max_delegations_per_pair_per_turn: 4,
      max_ask_user_per_turn: 4,
      max_read_skill_file_per_turn: 8,
      max_web_search_per_turn: 5,
    },
  }
}

describe('preflightDelegation', () => {
  it('rejects research-shaped task to assignee lacking web-search', () => {
    // Bug shape: assignee can fetch URLs but team explicitly forbids web-search
    // via denylist, defeating the coupling rule. Preflight should catch it.
    const member = fakeAgent({
      id: 'a-1',
      role: 'WeirdRole',
      skills: ['web-fetch'],
    })
    const team = fakeTeam([member], ['web-search']) // explicit denial
    const err = preflightDelegation(team, member, 'search the web for latest AI model releases')
    expect(err).not.toBeNull()
    expect(err).toMatch(/web-search/)
  })

  it('passes through when assignee has web-search via role default', () => {
    const researcher = fakeAgent({ id: 'a-1', role: 'Researcher' })
    const team = fakeTeam([researcher])
    expect(
      preflightDelegation(team, researcher, 'research the latest AI model releases for me'),
    ).toBeNull()
  })

  it('passes through when the task is non-research (no false positives)', () => {
    const designer = fakeAgent({
      id: 'a-1',
      role: 'WeirdRole',
      skills: ['pdf'],
    })
    const team = fakeTeam([designer], ['web-search'])
    expect(
      preflightDelegation(team, designer, 'render this report to a PDF document'),
    ).toBeNull()
  })

  it('detects Korean research keywords', () => {
    const member = fakeAgent({
      id: 'a-1',
      role: 'WeirdRole',
      skills: ['web-fetch'],
    })
    const team = fakeTeam([member], ['web-search'])
    const err = preflightDelegation(team, member, '최신 AI 모델 발표를 조사해줘')
    expect(err).not.toBeNull()
  })
})

describe('makeBudgetExhaustedResult', () => {
  const target = fakeAgent({ id: 'a-sub', role: 'Researcher' })

  it('emits structured payload with status + retry counters + guidance', () => {
    const out = makeBudgetExhaustedResult({
      assignee: target,
      siblingIndex: 2,
      maxRounds: 24,
      partialOutput: 'I started looking at...',
      retriesUsed: 0,
      retryCap: BUDGET_EXHAUSTED_RETRY_CAP,
    })
    expect(out.status).toBe('budget_exhausted')
    expect(out.assignee_id).toBe('a-sub')
    expect(out.sibling_index).toBe(2)
    expect(out.max_rounds).toBe(24)
    expect(out.retries_used).toBe(0)
    expect(out.retries_left).toBe(BUDGET_EXHAUSTED_RETRY_CAP)
    expect(String(out.guidance)).toMatch(/narrower|narrow/)
  })

  it('shifts guidance when retry quota is spent', () => {
    const out = makeBudgetExhaustedResult({
      assignee: target,
      siblingIndex: null,
      maxRounds: 24,
      partialOutput: '',
      retriesUsed: BUDGET_EXHAUSTED_RETRY_CAP,
      retryCap: BUDGET_EXHAUSTED_RETRY_CAP,
    })
    expect(out.retries_left).toBe(0)
    expect(String(out.guidance)).toMatch(/exhausted|consolidate/i)
  })

  it('truncates very long partial output to a bounded excerpt', () => {
    const huge = 'x'.repeat(5000)
    const out = makeBudgetExhaustedResult({
      assignee: target,
      siblingIndex: null,
      maxRounds: 24,
      partialOutput: huge,
      retriesUsed: 0,
      retryCap: BUDGET_EXHAUSTED_RETRY_CAP,
    })
    const excerpt = out.partial_output_excerpt as string
    expect(excerpt.length).toBeLessThan(huge.length)
    expect(excerpt.endsWith('…')).toBe(true)
  })
})

describe('composeSystemPrompt — skill enumeration with "when to use" hints', () => {
  const fakeWebSearch: SkillDef = {
    name: 'web-search',
    description:
      'Search the web and return a ranked list of candidate URLs with titles ' +
      'and snippets. Use this BEFORE `web-fetch` when you don\'t already know ' +
      'the right URL — never guess domain names, just search.',
    kind: 'agent',
    skillDir: '/tmp/x',
    source: 'bundled',
    body: '',
    fileTree: [],
  }
  const fakeWebFetch: SkillDef = {
    name: 'web-fetch',
    description:
      'Fetch ONE specific URL you ALREADY have and return clean markdown. ' +
      'Use AFTER web-search. NEVER fetch search-engine result pages.',
    kind: 'agent',
    skillDir: '/tmp/x',
    source: 'bundled',
    body: '',
    fileTree: [],
  }

  it('lists each skill with its leading "when to use" sentence', () => {
    const out = composeSystemPrompt('You are a researcher.', [fakeWebSearch, fakeWebFetch], '')
    // Each skill named with a real description (not "(no description)").
    expect(out).toMatch(/`web-search`\s+—\s+Search the web/)
    expect(out).toMatch(/`web-fetch`\s+—\s+Fetch ONE specific URL/)
    // Anti-search-engine guard + ordering nudge live in the SKILL.md
    // description (per-skill line), NOT in a preamble block. This keeps the
    // workflow advice scoped to agents that actually own the skill and avoids
    // a global "do it yourself" tone that suppressed delegation.
    expect(out.toLowerCase()).toContain('search-engine')
    expect(out).toMatch(/use\s+after\s+web-search/i)
  })

  it('does NOT inject a global "always web-search first" preamble', () => {
    const out = composeSystemPrompt('plain.', [fakeWebSearch, fakeWebFetch], '')
    // The old IMPORTANT block was anti-delegation: it told every agent to do
    // web work themselves rather than route to a subordinate. Per-skill
    // descriptions carry the same guidance now, scoped to whoever owns it.
    expect(out).not.toMatch(/IMPORTANT:.*web-search.*first/i)
    expect(out).not.toMatch(/ALWAYS go `web-search` first/i)
  })

  it('does not produce the legacy bare-name list with no descriptions', () => {
    const out = composeSystemPrompt('You are a researcher.', [fakeWebSearch], '')
    // Heuristic: a "name — desc" line should be present.
    expect(out).toMatch(/`web-search`\s+—\s+\S/)
  })

  it('returns base prompt with today block when no skills + no team section', () => {
    // Today block is ambient context — present even on the most minimal
    // prompt so single-agent runs (no team, no skills) still get the
    // current-year anchor that fixes the "training-cutoff year leakage"
    // bug in web-search queries.
    const out = composeSystemPrompt('plain prompt', [], '')
    expect(out).toContain('plain prompt')
    expect(out).toMatch(/^plain prompt/)
    expect(out).toContain('# Today')
  })

  it('injects an ISO YYYY-MM-DD date in a `# Today` block', () => {
    const out = composeSystemPrompt('persona body.', [fakeWebSearch], 'team block')
    // Header present.
    expect(out).toContain('# Today')
    // ISO date matches today (UTC). Match by pattern, not literal — the
    // build of this test must keep working tomorrow.
    const todayIso = new Date().toISOString().slice(0, 10)
    expect(out).toContain(todayIso)
    // The anchoring imperative is what actually fixes the bug.
    expect(out.toLowerCase()).toContain('training-cutoff year')
    expect(out).toMatch(/anchor to \d{4}/i)
  })

  it('places the today block between persona body and team section', () => {
    const out = composeSystemPrompt('# Persona\nyou are X', [], 'TEAM_BLOCK_MARKER')
    const personaIdx = out.indexOf('# Persona')
    const todayIdx = out.indexOf('# Today')
    const teamIdx = out.indexOf('TEAM_BLOCK_MARKER')
    expect(personaIdx).toBeGreaterThanOrEqual(0)
    expect(todayIdx).toBeGreaterThan(personaIdx)
    expect(teamIdx).toBeGreaterThan(todayIdx)
  })
})

describe('composeSystemPrompt — about-this-app + built-in tools', () => {
  it('always includes the # About this app preamble (even with no skills/tools)', () => {
    const out = composeSystemPrompt('persona.', [], '')
    expect(out).toContain('# About this app')
    expect(out).toContain('OpenHive')
    expect(out).toContain('db_*')
    expect(out).toContain('panel_*')
  })

  it('omits the # Built-in tools section when no categorised tools are passed', () => {
    const out = composeSystemPrompt('persona.', [], '')
    expect(out).not.toContain('# Built-in tools')
  })

  it('renders only the DB subsection when only db tools are categorised', () => {
    const tools = [
      { name: 'db_query', description: 'SELECT / FTS5 search.', category: 'db' as const },
      { name: 'db_exec', description: 'INSERT/UPDATE/DELETE/CREATE/ALTER.', category: 'db' as const },
    ]
    const out = composeSystemPrompt('persona.', [], '', tools)
    expect(out).toContain('# Built-in tools')
    expect(out).toMatch(/##\s+Database/)
    expect(out).toMatch(/`db_query`/)
    expect(out).toMatch(/`db_exec`/)
    expect(out).not.toMatch(/##\s+Dashboard panels/)
  })

  it('renders panel + dashboard subsections when both are present', () => {
    const tools = [
      { name: 'panel_list', description: 'List every panel on the dashboard.', category: 'panel' as const },
      { name: 'panel_install', description: 'Install a panel frame.', category: 'panel' as const },
      {
        name: 'dashboard_list_backups',
        description: 'List timestamped backups.',
        category: 'dashboard' as const,
      },
    ]
    const out = composeSystemPrompt('persona.', [], '', tools)
    expect(out).toMatch(/##\s+Dashboard panels/)
    expect(out).toMatch(/##\s+Dashboard \(whole-team\)/)
    expect(out).toMatch(/`panel_install`/)
    expect(out).toMatch(/`dashboard_list_backups`/)
  })

  it('skips tools without a category', () => {
    const tools = [
      { name: 'delegate_to', description: 'Delegate to a sub.', category: null },
      { name: 'db_query', description: 'SELECT.', category: 'db' as const },
    ]
    const out = composeSystemPrompt('persona.', [], '', tools)
    expect(out).toContain('# Built-in tools')
    expect(out).toMatch(/`db_query`/)
    expect(out).not.toMatch(/`delegate_to`/)
  })
})
