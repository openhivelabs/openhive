/**
 * Cross-provider caching strategy tests — spec
 * docs/superpowers/specs/2026-04-22-caching-strategy.md.
 */

import { describe, expect, it } from 'vitest'
import {
  AnthropicCachingStrategy,
  CodexCachingStrategy,
  NoopCachingStrategy,
} from './caching'
import type { ChatMessage, ToolSpec } from './types'

describe('AnthropicCachingStrategy', () => {
  const strategy = new AnthropicCachingStrategy()

  const tools: ToolSpec[] = [
    {
      type: 'function',
      function: {
        name: 'first_tool',
        description: 'first',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'last_tool',
        description: 'last',
        parameters: { type: 'object', properties: {} },
      },
    },
  ]

  const baseReq = {
    system: 'You are Claude.',
    messages: [
      { role: 'user', content: 'hello' } as { role: string; content: string },
    ],
    tools,
    model: 'claude-sonnet-4-5',
    maxTokens: 4096,
  }

  it('emits 3 cache_control breakpoints in expected positions', () => {
    const payload = strategy.applyToRequest({ ...baseReq })

    // 1. system[0].cache_control
    const sys = payload.system as Array<Record<string, unknown>>
    expect(sys).toHaveLength(1)
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' })

    // 2. tools[last].cache_control
    const t = payload.tools as Array<Record<string, unknown>>
    expect(t).toHaveLength(2)
    expect(t[0]!.cache_control).toBeUndefined()
    expect(t[1]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(t[1]!.name).toBe('last_tool')

    // 3. messages[last].content[last].cache_control
    const last = payload.messages[payload.messages.length - 1]!
    const blocks = last.content as Array<Record<string, unknown>>
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  it('byte-equivalent snapshot for reference request', () => {
    const payload = strategy.applyToRequest({ ...baseReq })
    expect(payload).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hello',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      system: [
        {
          type: 'text',
          text: 'You are Claude.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [
        {
          name: 'first_tool',
          description: 'first',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'last_tool',
          description: 'last',
          input_schema: { type: 'object', properties: {} },
          cache_control: { type: 'ephemeral' },
        },
      ],
    })
  })

  it('omits tools + system when empty', () => {
    const payload = strategy.applyToRequest({
      ...baseReq,
      system: null,
      tools: null,
    })
    expect(payload.system).toBeUndefined()
    expect(payload.tools).toBeUndefined()
  })
})

describe('CodexCachingStrategy', () => {
  const strategy = new CodexCachingStrategy()

  const baseReq = {
    model: 'gpt-5-codex',
    input: [{ type: 'message', role: 'user', content: [] }],
    tools: null,
    instructions: 'be helpful',
  }

  it('attaches previous_response_id and flips store:true when chaining', () => {
    const payload = strategy.applyToRequest({
      ...baseReq,
      previousResponseId: 'resp_abc123',
    })
    expect(payload.previous_response_id).toBe('resp_abc123')
    expect(payload.store).toBe(true)
  })

  it('omits previous_response_id and keeps store:false when not chaining', () => {
    const payload = strategy.applyToRequest({
      ...baseReq,
      previousResponseId: null,
    })
    expect(payload.previous_response_id).toBeUndefined()
    expect(payload.store).toBe(false)
  })

  it('extracts response id from response.created envelope', () => {
    const id = strategy.extractResponseId({
      type: 'response.created',
      response: { id: 'resp_xyz', status: 'in_progress' },
    })
    expect(id).toBe('resp_xyz')
  })

  it('extracts response id from top-level id field', () => {
    const id = strategy.extractResponseId({ id: 'resp_flat', type: 'response.completed' })
    expect(id).toBe('resp_flat')
  })

  it('returns null on unrelated envelopes', () => {
    expect(strategy.extractResponseId({ type: 'response.output_text.delta' })).toBeNull()
    expect(strategy.extractResponseId(null)).toBeNull()
    expect(strategy.extractResponseId('nope')).toBeNull()
  })
})

describe('NoopCachingStrategy', () => {
  const strategy = new NoopCachingStrategy()

  it('returns payload without cache fields; tools pass through', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    const tools: ToolSpec[] = [
      { type: 'function', function: { name: 'x', parameters: {} } },
    ]
    const payload = strategy.applyToRequest({
      model: 'gpt-4o',
      messages,
      tools,
      temperature: 0.5,
    })
    expect(payload).toEqual({
      model: 'gpt-4o',
      messages,
      temperature: 0.5,
      stream: true,
      tools,
      tool_choice: 'auto',
    })
  })

  it('omits tool fields when none provided', () => {
    const payload = strategy.applyToRequest({
      model: 'gpt-4o',
      messages: [],
      tools: null,
      temperature: 0.7,
    })
    expect(payload.tools).toBeUndefined()
    expect(payload.tool_choice).toBeUndefined()
  })
})
