import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ToolSpec } from '../providers/types'
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  estimateToolsTokens,
  shouldAutoCompact,
  shouldBlockTurn,
  shouldMicrocompact,
  tokenCountWithEstimation,
} from './tokens'

const ENV_KEYS = ['OPENHIVE_TOKEN_PAD_FACTOR'] as const

afterEach(() => {
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k)
})

describe('estimateTextTokens', () => {
  it('empty / nullish → 0', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens(null)).toBe(0)
    expect(estimateTextTokens(undefined)).toBe(0)
  })

  it('400 chars → ceil(100 * 4/3) = 134', () => {
    expect(estimateTextTokens('a'.repeat(400))).toBe(134)
  })

  it('pad factor from env', () => {
    process.env.OPENHIVE_TOKEN_PAD_FACTOR = '1'
    // 400 chars / 4 chars-per-token * 1.0 = 100
    expect(estimateTextTokens('a'.repeat(400))).toBe(100)
  })

  it('invalid pad factor falls back to default', () => {
    process.env.OPENHIVE_TOKEN_PAD_FACTOR = 'bogus'
    expect(estimateTextTokens('a'.repeat(400))).toBe(134)
  })
})

describe('estimateMessageTokens', () => {
  it('string content includes ROLE_OVERHEAD', () => {
    const msg: ChatMessage = { role: 'user', content: 'hello world' }
    // 11 chars → ceil(11/4 * 4/3) = ceil(3.666) = 4; + overhead 4 = 8
    expect(estimateMessageTokens(msg)).toBe(8)
  })

  it('image block adds flat 2_000', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [{ type: 'image', source: {} }] as unknown as string,
    }
    expect(estimateMessageTokens(msg)).toBeGreaterThanOrEqual(2_000)
  })

  it('tool_calls contribute name + args + 8 overhead', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"foo"}' },
        },
      ],
    }
    // ROLE_OVERHEAD(4) + name(ceil(6/4*4/3)=2) + args(ceil(11/4*4/3)=4) + 8 = 18
    expect(estimateMessageTokens(msg)).toBe(18)
  })

  it('tool_result block counts content', () => {
    const msg: ChatMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', content: 'result body goes here' }] as unknown as string,
      tool_call_id: 'call_1',
    }
    expect(estimateMessageTokens(msg)).toBeGreaterThan(4)
  })
})

describe('estimateMessagesTokens', () => {
  it('sums across messages', () => {
    const a: ChatMessage = { role: 'user', content: 'hi' }
    const b: ChatMessage = { role: 'assistant', content: 'hello back' }
    expect(estimateMessagesTokens([a, b])).toBe(estimateMessageTokens(a) + estimateMessageTokens(b))
  })
})

describe('estimateToolsTokens', () => {
  it('empty/undefined → 0', () => {
    expect(estimateToolsTokens(undefined)).toBe(0)
    expect(estimateToolsTokens(null)).toBe(0)
    expect(estimateToolsTokens([])).toBe(0)
  })

  it('non-empty → JSON length estimate + per-tool overhead', () => {
    const tools: ToolSpec[] = [
      {
        type: 'function',
        function: { name: 'a', description: 'x', parameters: {} },
      },
    ]
    const t = estimateToolsTokens(tools)
    expect(t).toBeGreaterThan(0)
    // Must strictly exceed the text-only estimate because of +4 per tool.
    expect(t).toBe(estimateTextTokens(JSON.stringify(tools)) + 4)
  })
})

describe('tokenCountWithEstimation', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third — after API report' },
  ]

  it('with API value + index → authoritative + tail estimate', () => {
    const count = tokenCountWithEstimation(msgs, {
      apiReportedInputTokens: 50_000,
      apiReportedAtIndex: msgs.length - 2,
    })
    // Just last message (index 3) added via estimate.
    const tail = estimateMessageTokens(msgs[3] as ChatMessage)
    expect(count).toBe(50_000 + tail)
  })

  it('no API value → estimates everything + system + tools', () => {
    const count = tokenCountWithEstimation(msgs, { systemTokens: 10, toolsTokens: 5 })
    expect(count).toBe(10 + 5 + estimateMessagesTokens(msgs))
  })

  it('apiReportedAtIndex at last message → added = 0', () => {
    const count = tokenCountWithEstimation(msgs, {
      apiReportedInputTokens: 42_000,
      apiReportedAtIndex: msgs.length - 1,
    })
    expect(count).toBe(42_000)
  })
})

describe('threshold helpers', () => {
  it('shouldMicrocompact true above warning (960K for opus[1m])', () => {
    expect(shouldMicrocompact(961_000, 'claude-code', 'claude-opus-4-7[1m]')).toBe(true)
    expect(shouldMicrocompact(960_000, 'claude-code', 'claude-opus-4-7[1m]')).toBe(false)
  })

  it('shouldAutoCompact at 967K boundary', () => {
    expect(shouldAutoCompact(967_001, 'claude-code', 'claude-opus-4-7[1m]')).toBe(true)
    expect(shouldAutoCompact(967_000, 'claude-code', 'claude-opus-4-7[1m]')).toBe(false)
  })

  it('shouldBlockTurn at 977K boundary', () => {
    expect(shouldBlockTurn(978_000, 'claude-code', 'claude-opus-4-7[1m]')).toBe(true)
    expect(shouldBlockTurn(977_000, 'claude-code', 'claude-opus-4-7[1m]')).toBe(false)
    expect(shouldBlockTurn(960_000, 'claude-code', 'claude-opus-4-7[1m]')).toBe(false)
  })
})
