import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../providers/types'
import {
  FORK_BOILERPLATE_OPEN,
  FORK_PLACEHOLDER,
  type TurnSnapshot,
  buildForkedMessages,
  decideForkOrFresh,
  isInForkChild,
} from './fork'
import type { AgentSpec } from './team'

const agent = (over: Partial<AgentSpec> = {}): AgentSpec =>
  ({
    id: 'n1',
    role: 'writer',
    provider_id: 'claude-code',
    model: 'claude-sonnet-4-5',
    persona: [],
    skills: [],
    tools: [],
    mcp: [],
    max_parallel: 5,
    ...over,
  }) as unknown as AgentSpec

const parentHistory = (toolCallId = 'call_a'): ChatMessage[] => [
  { role: 'user', content: 'goal' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: toolCallId,
        type: 'function' as const,
        function: {
          name: 'delegate_parallel',
          arguments: JSON.stringify({ assignee: 'writer', tasks: ['t0', 't1'] }),
        },
      },
    ],
  },
]

const snapshot = (over: Partial<TurnSnapshot> = {}): TurnSnapshot => ({
  systemPrompt: 'SYSTEM',
  history: parentHistory(),
  tools: [],
  providerId: 'claude-code',
  model: 'claude-opus-4-7',
  nodeId: 'lead',
  depth: 0,
  builtAt: Date.now(),
  ...over,
})

describe('isInForkChild', () => {
  it('returns false on empty history', () => {
    expect(isInForkChild([])).toBe(false)
  })

  it('returns false when last user message has no sentinel', () => {
    expect(isInForkChild([{ role: 'user', content: 'plain task' }])).toBe(false)
  })

  it('returns true when last user string content includes the sentinel', () => {
    expect(
      isInForkChild([
        { role: 'user', content: 'goal' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: `${FORK_BOILERPLATE_OPEN}\nsibling 1/3\n</...>\n\ntask` },
      ]),
    ).toBe(true)
  })

  it('returns false when only an assistant text contains the sentinel', () => {
    expect(
      isInForkChild([
        { role: 'user', content: 'goal' },
        { role: 'assistant', content: `echoing ${FORK_BOILERPLATE_OPEN} back` },
        { role: 'user', content: 'follow-up' },
      ]),
    ).toBe(false)
  })

  it('scans block-array user content for sentinel', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'goal' },
      {
        role: 'user',
        // Anthropic-shape block content may appear post-merge. Cast through
        // unknown to simulate providers that produce block arrays.
        content: [
          { type: 'text', text: `${FORK_BOILERPLATE_OPEN}\nsibling\n</...>` },
        ] as unknown as string,
      },
    ]
    expect(isInForkChild(history)).toBe(true)
  })
})

describe('buildForkedMessages', () => {
  it('slices parent history by reference (byte-identical entries)', () => {
    const hist = parentHistory()
    const snap = snapshot({ history: hist })
    const out = buildForkedMessages({
      snapshot: snap,
      parentToolCallId: 'call_a',
      siblingIndex: 0,
      siblingCount: 2,
      parentRole: 'lead',
      parentId: 'lead',
      childRole: 'writer',
      task: 't0',
    })
    expect(out[0]).toBe(hist[0])
    expect(out[1]).toBe(hist[1])
    expect(out.length).toBe(hist.length + 2)
  })

  it('appends tool_result with FORK_PLACEHOLDER + user with directive', () => {
    const out = buildForkedMessages({
      snapshot: snapshot(),
      parentToolCallId: 'call_a',
      siblingIndex: 2,
      siblingCount: 5,
      parentRole: 'lead',
      parentId: 'lead-1',
      childRole: 'writer',
      task: 'draft section 3',
    })
    const toolMsg = out[out.length - 2] as ChatMessage
    const userMsg = out[out.length - 1] as ChatMessage
    expect(toolMsg.role).toBe('tool')
    expect(toolMsg.tool_call_id).toBe('call_a')
    expect(toolMsg.content).toBe(FORK_PLACEHOLDER)
    expect(userMsg.role).toBe('user')
    expect(typeof userMsg.content).toBe('string')
    expect(userMsg.content as string).toContain(FORK_BOILERPLATE_OPEN)
    expect(userMsg.content as string).toContain('sibling 3/5')
    expect(userMsg.content as string).toContain('lead#lead-1')
    expect(userMsg.content as string).toContain('draft section 3')
  })

  it('produces prefix SHA-identical arrays across siblings (exc. last user)', async () => {
    const crypto = await import('node:crypto')
    const hist = parentHistory()
    const snap = snapshot({ history: hist })
    const hashes = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const msgs = buildForkedMessages({
        snapshot: snap,
        parentToolCallId: 'call_a',
        siblingIndex: i,
        siblingCount: 5,
        parentRole: 'lead',
        parentId: 'lead-1',
        childRole: 'writer',
        task: `task_${i}`,
      })
      // Hash everything except the final (per-sibling) user message.
      const prefix = msgs.slice(0, -1)
      hashes.add(crypto.createHash('sha256').update(JSON.stringify(prefix)).digest('hex'))
    }
    expect(hashes.size).toBe(1)
  })

  it('throws when parent last message is not assistant+tool_use', () => {
    const bad = snapshot({
      history: [
        { role: 'user', content: 'goal' },
        { role: 'assistant', content: 'text only, no tool_calls' },
      ],
    })
    expect(() =>
      buildForkedMessages({
        snapshot: bad,
        parentToolCallId: 'call_a',
        siblingIndex: 0,
        siblingCount: 2,
        parentRole: 'lead',
        parentId: 'lead',
        childRole: 'writer',
        task: 't',
      }),
    ).toThrow(/assistant\+tool_use/)
  })
})

describe('decideForkOrFresh — six-gate', () => {
  const priorEnv = process.env.OPENHIVE_FORK_DISABLE
  beforeEach(() => {
    process.env.OPENHIVE_FORK_DISABLE = undefined
  })
  afterEach(() => {
    if (priorEnv === undefined) process.env.OPENHIVE_FORK_DISABLE = undefined
    else process.env.OPENHIVE_FORK_DISABLE = priorEnv
  })

  it('forks when all six gates pass', () => {
    const d = decideForkOrFresh({
      snapshot: snapshot(),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1' }),
      depth: 0,
    })
    expect(d.fork).toBe(true)
    expect(d.snapshot).toBeDefined()
  })

  it('gate 1: env_disabled', () => {
    process.env.OPENHIVE_FORK_DISABLE = '1'
    const d = decideForkOrFresh({
      snapshot: snapshot(),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('env_disabled')
  })

  it('gate 2: non_claude child', () => {
    const d = decideForkOrFresh({
      snapshot: snapshot(),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1', provider_id: 'codex' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('non_claude')
  })

  it('gate 3: provider_mismatch — snapshot is codex but child is claude', () => {
    const d = decideForkOrFresh({
      snapshot: snapshot({ providerId: 'codex' }),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1', provider_id: 'claude-code' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('provider_mismatch')
  })

  it('gate 2: anthropic api_key child is allowed (treated as Anthropic-family)', () => {
    const d = decideForkOrFresh({
      snapshot: snapshot({ providerId: 'anthropic' }),
      parent: agent({ id: 'lead', provider_id: 'anthropic' }),
      child: agent({ id: 'writer-1', provider_id: 'anthropic' }),
      depth: 0,
    })
    expect(d.fork).toBe(true)
  })

  it('gate 3: cross-provider claude-code → anthropic falls back to provider_mismatch', () => {
    const d = decideForkOrFresh({
      snapshot: snapshot({ providerId: 'claude-code' }),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1', provider_id: 'anthropic' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('provider_mismatch')
  })

  it('gate 4a: no snapshot', () => {
    const d = decideForkOrFresh({
      snapshot: undefined,
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('no_snapshot')
  })

  it('gate 4b: snapshot from different node', () => {
    const d = decideForkOrFresh({
      snapshot: snapshot({ nodeId: 'someone-else' }),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('no_snapshot')
  })

  it('gate 4c: snapshot from different depth', () => {
    const d = decideForkOrFresh({
      snapshot: snapshot({ depth: 2 }),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('no_snapshot')
  })

  it('gate 5: stale snapshot (> 60s)', () => {
    const d = decideForkOrFresh({
      snapshot: snapshot({ builtAt: Date.now() - 120_000 }),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('no_snapshot')
  })

  it('gate 6: recursive (already inside a fork child)', () => {
    const recursiveHistory: ChatMessage[] = [
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: `${FORK_BOILERPLATE_OPEN}\nsibling 1/3\n</...>\n\ntask`,
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_b',
            type: 'function' as const,
            function: { name: 'delegate_parallel', arguments: '{}' },
          },
        ],
      },
    ]
    const d = decideForkOrFresh({
      snapshot: snapshot({ history: recursiveHistory }),
      parent: agent({ id: 'lead' }),
      child: agent({ id: 'writer-1' }),
      depth: 0,
    })
    expect(d.fork).toBe(false)
    expect(d.reason).toBe('recursive')
  })
})
