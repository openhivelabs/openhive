/**
 * S3 fork e2e: mock `claude.streamMessages`, fire `runParallelDelegation`-style
 * fan-out through the underlying fork building blocks, and verify that every
 * sibling's payload system / tools / prefix serializes to the same SHA256 —
 * marking byte-identical prompt-cache eligibility.
 *
 * This exercises:
 *   - `buildForkedMessages` + `streamTurnFork`-equivalent flow via the
 *     claude provider's `streamMessages` → `splitSystem` / `mergeAdjacentUsers`
 *     / `AnthropicCachingStrategy` pipeline.
 *   - Sibling payload SHA256 identity on (system, tools, messages-prefix).
 *   - Last user message differs per-sibling (task suffix).
 */
import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// Stub out Claude auth: `streamMessages` calls `getAccessToken` before issuing
// the real HTTP request. We mock the token loader so no fetch / disk IO fires.
vi.mock('../tokens', () => ({
  loadToken: () => ({
    provider_id: 'claude-code',
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    scope: null,
    account_label: 'test',
    account_id: null,
  }),
  saveToken: () => {},
  getAccountLabel: () => 'test',
}))

// Capture every outgoing Anthropic request so we can hash per-sibling payloads.
const captured: Array<Record<string, unknown>> = []

type FetchStub = (url: string, init: RequestInit) => Promise<Response>
const fetchStub: FetchStub = async (_url, init) => {
  const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
  captured.push(body)
  // Minimal SSE body: message_start → message_stop. No content_block emitted
  // so the caller ends with 'stop' / no tool calls.
  const sse =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":8,"cache_creation_input_tokens":0}}}\n' +
    'data: {"type":"message_stop"}\n'
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse))
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    body: stream,
    text: async () => sse,
  } as Response
}

// biome-ignore lint/suspicious/noExplicitAny: test-only fetch stub
;(globalThis as any).fetch = vi.fn(fetchStub)

import type { ChatMessage } from '../providers/types'
import { type TurnSnapshot, buildForkedMessages } from './fork'
import { stream } from './providers'

const sha = (obj: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex')

describe('S3 fork e2e — 5-child fan-out payload identity', () => {
  it('produces byte-identical system/tools/prefix across 5 siblings, distinct last-user', async () => {
    captured.length = 0

    const parentSystem = `You are the Lead. ${'X'.repeat(400)}`
    const parentHistory: ChatMessage[] = [
      { role: 'user', content: 'Build a report on widgets.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_parallel_1',
            type: 'function' as const,
            function: {
              name: 'delegate_parallel',
              arguments: JSON.stringify({
                assignee: 'writer',
                tasks: ['t0', 't1', 't2', 't3', 't4'],
              }),
            },
          },
        ],
      },
    ]
    const parentTools = [
      {
        type: 'function' as const,
        function: {
          name: 'delegate_parallel',
          description: 'Fan out to writers.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'delegate_to',
          description: 'Single delegation.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]

    const snap: TurnSnapshot = {
      systemPrompt: parentSystem,
      history: parentHistory,
      tools: parentTools,
      providerId: 'claude-code',
      model: 'claude-opus-4-7',
      nodeId: 'lead',
      depth: 0,
      builtAt: Date.now(),
    }

    // Fire 5 siblings sequentially through the provider pipeline. This mirrors
    // what `streamTurnFork` does per child, minus the event envelope.
    const tasks = ['write intro', 'draft section 2', 'analyze data', 'recs', 'summary']
    for (let i = 0; i < 5; i++) {
      const taskText = tasks[i] ?? ''
      const childHistory = buildForkedMessages({
        snapshot: snap,
        parentToolCallId: 'call_parallel_1',
        siblingIndex: i,
        siblingCount: 5,
        parentRole: 'lead',
        parentId: 'lead',
        childRole: 'writer',
        task: taskText,
      })
      const messages: ChatMessage[] = [{ role: 'system', content: parentSystem }, ...childHistory]
      // Drain the stream; our fetch stub returns stop immediately.
      for await (const _d of stream('claude-code', 'claude-sonnet-4-5', messages, parentTools, {
        useExactTools: true,
        overrideSystem: parentSystem,
      })) {
        // no-op
      }
    }

    expect(captured.length).toBe(5)

    // System SHA256 must be identical across all 5.
    const sysHashes = new Set(captured.map((p) => sha(p.system)))
    expect(sysHashes.size).toBe(1)

    // Tools SHA256 must be identical across all 5.
    const toolHashes = new Set(captured.map((p) => sha(p.tools)))
    expect(toolHashes.size).toBe(1)

    // Messages-prefix (all but the final user message) must be identical.
    const prefixHashes = new Set(
      captured.map((p) => {
        const msgs = p.messages as unknown[]
        return sha(msgs.slice(0, -1))
      }),
    )
    expect(prefixHashes.size).toBe(1)

    // Last message varies per sibling (task suffix differs).
    const lastHashes = new Set(
      captured.map((p) => {
        const msgs = p.messages as unknown[]
        return sha(msgs[msgs.length - 1])
      }),
    )
    expect(lastHashes.size).toBe(5)

    // Sanity: each final user message contains the boilerplate + its unique task.
    for (let i = 0; i < 5; i++) {
      const entry = captured[i]
      if (!entry) continue
      const msgs = entry.messages as Array<{ content: unknown }>
      const last = msgs[msgs.length - 1]
      if (!last) continue
      // After mergeAdjacentUsers + caching strategy, last.content is a block array.
      const blocks = (last.content as Array<{ type?: string; text?: string }>) || []
      const allText = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n')
      expect(allText).toContain('<OPENHIVE_FORK_BOILERPLATE>')
      expect(allText).toContain(`sibling ${i + 1}/5`)
      expect(allText).toContain(tasks[i] ?? '')
    }
  })
})
