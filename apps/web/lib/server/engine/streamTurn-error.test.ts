/**
 * Fix A — provider stream exception handling.
 *
 * The `for await (const delta of stream(...))` inside `streamTurn` is wrapped
 * in a try/catch. When the provider iterator throws mid-stream, the catch
 * yields a structured `node_error` event followed by a synthesized
 * `_turn_marker` `node_finished{stop_reason:'provider_error'}`, then re-throws
 * so outer machinery still emits `run_error` (depth=0) or
 * `delegation_closed{error:true}` (depth ≥ 1).
 *
 * These tests mock `./providers` so we can drive the iterator into the
 * failure path deterministically — no real network / provider auth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock provider stream BEFORE importing session.ts. Each test re-assigns
// `currentStream` to control what the iterator does for that test.
let currentStream: () => AsyncGenerator<Record<string, unknown>> = async function* () {
  /* default: empty */
}

vi.mock('./providers', () => ({
  stream: (..._args: unknown[]) => currentStream(),
  buildMessages: (system: string, history: unknown[]) => [
    { role: 'system', content: system },
    ...(history as Array<Record<string, unknown>>),
  ],
}))

import type { Event } from '../events/schema'
import { streamTurn, type StreamTurnOpts } from './session'
import type { AgentSpec, TeamSpec } from './team'

const teamFixture: TeamSpec = {
  id: 'team-x',
  name: 'Test',
  agents: [],
  edges: [],
  entry_agent_id: null,
  allowed_skills: [],
  disabled_skills: [],
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

const nodeFixture: AgentSpec = {
  id: 'a-lead',
  role: 'Lead',
  label: 'Lead',
  provider_id: 'codex',
  model: 'gpt-5-mini',
  system_prompt: '',
  skills: [],
  max_parallel: 1,
  persona_path: null,
  persona_name: null,
}

function baseOpts(over: Partial<StreamTurnOpts> = {}): StreamTurnOpts {
  return {
    sessionId: 'sess-test',
    team: teamFixture,
    node: nodeFixture,
    systemPrompt: 'You are Lead.',
    history: [{ role: 'user', content: 'hello' }],
    tools: [],
    depth: 0,
    chainKey: 'sess-test:chain-test',
    ...over,
  }
}

async function collect(gen: AsyncGenerator<Event>): Promise<{
  events: Event[]
  threw: unknown | null
}> {
  const events: Event[] = []
  try {
    for await (const ev of gen) events.push(ev)
    return { events, threw: null }
  } catch (err) {
    return { events, threw: err }
  }
}

describe('streamTurn — provider mid-stream throw recovery', () => {
  beforeEach(() => {
    // Reset the provider mock to a known state before each test.
    currentStream = async function* () {
      /* default empty */
    }
  })

  afterEach(() => {
    // Clear engine state map so sessions don't leak between tests.
    const g = globalThis as unknown as { __openhive_engine_run?: unknown }
    g.__openhive_engine_run = undefined
  })

  it('yields node_error + node_finished(_turn_marker, provider_error) and re-throws', async () => {
    currentStream = async function* () {
      yield { kind: 'text', text: 'partial ' }
      throw new Error('boom: provider exploded mid-stream')
    }

    const { events, threw } = await collect(streamTurn(baseOpts()))

    // The throw must propagate so outer catches (runNode/runDelegation/
    // runTeamBody) can fire run_error or delegation_closed{error:true}.
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error).message)).toMatch(/boom/)

    // Find the node_error and the synthesized _turn_marker node_finished.
    const nodeError = events.find((e) => e.kind === 'node_error')
    expect(nodeError).toBeDefined()
    expect(nodeError!.data.provider_id).toBe('codex')
    expect(nodeError!.data.model).toBe('gpt-5-mini')
    expect(nodeError!.data.message).toMatch(/boom/)
    expect(nodeError!.data.last_delta_kind).toBe('text')
    expect(nodeError!.data.partial_text_len).toBe('partial '.length)
    expect(nodeError!.data.pending_tool_calls).toBe(0)
    expect(nodeError!.data.phase).toBe('stream')

    const turnMarker = events.find(
      (e) => e.kind === 'node_finished' && e.data._turn_marker === true,
    )
    expect(turnMarker).toBeDefined()
    expect(turnMarker!.data.stop_reason).toBe('provider_error')
    expect(turnMarker!.data.output).toBe('partial ')

    // Order: node_error must come BEFORE the _turn_marker node_finished so
    // diagnostic context is on the wire ahead of the terminal marker.
    const errIdx = events.indexOf(nodeError!)
    const markerIdx = events.indexOf(turnMarker!)
    expect(errIdx).toBeLessThan(markerIdx)
  })

  it('captures pending tool_calls count when throw lands mid-tool_call', async () => {
    currentStream = async function* () {
      yield { kind: 'tool_call', index: 0, id: 'call_a', name: 'web_search', arguments_chunk: '{"q":' }
      throw new Error('socket reset')
    }

    const { events, threw } = await collect(streamTurn(baseOpts()))
    expect(threw).toBeInstanceOf(Error)
    const nodeError = events.find((e) => e.kind === 'node_error')!
    expect(nodeError.data.last_delta_kind).toBe('tool_call')
    expect(nodeError.data.pending_tool_calls).toBe(1)
    expect(nodeError.data.partial_text_len).toBe(0)
  })

  it('clean stream (no throw) does NOT emit node_error', async () => {
    currentStream = async function* () {
      yield { kind: 'text', text: 'all good' }
      yield { kind: 'stop', reason: 'stop' }
    }
    const { events, threw } = await collect(streamTurn(baseOpts()))
    expect(threw).toBeNull()
    expect(events.find((e) => e.kind === 'node_error')).toBeUndefined()
  })
})
