/**
 * Synthetic SSE fixtures replayed through `normalizeResponsesStream`. Event
 * shapes match the documented Responses API + the inline comments in the
 * normalizer (which were written against live Codex captures).
 *
 * Phase B is a pure refactor — these tests pin the contract so any future
 * tweak to the normalizer shows up as a snapshot diff.
 */

import { describe, expect, it } from 'vitest'
import { extractCompletedMessageText, normalizeResponsesStream } from './openai-response-shared'
import type { StreamDelta } from './types'

async function collect(events: Record<string, unknown>[]): Promise<StreamDelta[]> {
  async function* iter() {
    for (const ev of events) yield ev
  }
  const out: StreamDelta[] = []
  for await (const d of normalizeResponsesStream(iter())) out.push(d)
  return out
}

describe('normalizeResponsesStream — text-only turn', () => {
  it('emits text → usage → stop(stop)', async () => {
    const out = await collect([
      { type: 'response.output_text.delta', delta: 'Hello ' },
      { type: 'response.output_text.delta', delta: 'world.' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 11,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 0 },
          },
          output: [],
        },
      },
    ])
    expect(out).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world.' },
      { kind: 'usage', input_tokens: 11, output_tokens: 4, cache_read_tokens: 0 },
      { kind: 'stop', reason: 'stop' },
    ])
  })

  it('drops empty text deltas', async () => {
    const out = await collect([
      { type: 'response.output_text.delta', delta: '' },
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { usage: {}, output: [] } },
    ])
    const texts = out.filter((d): d is Extract<StreamDelta, { kind: 'text' }> => d.kind === 'text')
    expect(texts).toEqual([{ kind: 'text', text: 'ok' }])
  })
})

describe('normalizeResponsesStream — function call turn', () => {
  it('captures function_call ordinal + argument chunks, stop=tool_calls', async () => {
    const out = await collect([
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_xyz', name: 'do_thing' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"a":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '1}' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 5, output_tokens: 7 }, output: [] },
      },
    ])
    expect(out).toEqual([
      { kind: 'tool_call', index: 0, id: 'call_xyz', name: 'do_thing', arguments_chunk: '' },
      { kind: 'tool_call', index: 0, arguments_chunk: '{"a":' },
      { kind: 'tool_call', index: 0, arguments_chunk: '1}' },
      { kind: 'usage', input_tokens: 5, output_tokens: 7, cache_read_tokens: 0 },
      { kind: 'stop', reason: 'tool_calls' },
    ])
  })

  it('assigns dense ordinals to multiple function_calls', async () => {
    const out = await collect([
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_a', call_id: 'A', name: 'first' },
      },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_b', call_id: 'B', name: 'second' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{}' },
      { type: 'response.completed', response: { usage: {}, output: [] } },
    ])
    const calls = out.filter((d): d is Extract<StreamDelta, { kind: 'tool_call' }> => d.kind === 'tool_call')
    expect(calls.map((c) => c.index)).toEqual([0, 1, 1])
  })
})

describe('normalizeResponsesStream — web_search lifecycle', () => {
  it('attaches captured query to phase deltas and yields final sources card', async () => {
    const out = await collect([
      // Query captured on output_item.added (action.query)
      {
        type: 'response.output_item.added',
        item: {
          type: 'web_search_call',
          id: 'ws_1',
          action: { type: 'search', query: 'claude api 2026' },
        },
      },
      { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
      { type: 'response.web_search_call.searching', item_id: 'ws_1' },
      // Open-page action — URL becomes a source
      {
        type: 'response.output_item.done',
        item: {
          type: 'web_search_call',
          id: 'ws_2',
          action: {
            type: 'open_page',
            url: 'https://www.example.com/article',
            title: 'Example Article',
          },
        },
      },
      { type: 'response.web_search_call.completed', item_id: 'ws_1' },
      { type: 'response.output_text.delta', delta: 'Here is what I found.' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 100, output_tokens: 50 }, output: [] },
      },
    ])

    const phases = out
      .filter((d): d is Extract<StreamDelta, { kind: 'native_tool' }> => d.kind === 'native_tool')
      .map((d) => ({ phase: d.phase, query: d.query, sources: d.sources?.length }))
    expect(phases).toEqual([
      { phase: 'in_progress', query: 'claude api 2026', sources: undefined },
      { phase: 'searching', query: 'claude api 2026', sources: undefined },
      { phase: 'completed', query: 'claude api 2026', sources: undefined },
      // Final flush card
      { phase: 'completed', query: undefined, sources: 1 },
    ])
    const final = out[out.length - 2] as Extract<StreamDelta, { kind: 'native_tool' }>
    expect(final.sources).toEqual([
      { url: 'https://www.example.com/article', title: 'Example Article', domain: 'example.com' },
    ])
  })

  it('extracts inline URLs from text when sawNativeSearch=true and dedups vs open_page', async () => {
    const out = await collect([
      {
        type: 'response.output_item.added',
        item: { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'q' } },
      },
      { type: 'response.web_search_call.completed', item_id: 'ws_1' },
      // open_page captures one URL
      {
        type: 'response.output_item.done',
        item: {
          type: 'web_search_call',
          id: 'ws_2',
          action: { type: 'open_page', url: 'https://a.example.com/x' },
        },
      },
      // text delta has the SAME URL (should dedup) plus a NEW one
      {
        type: 'response.output_text.delta',
        delta: 'See https://a.example.com/x and https://b.example.com/y for refs.',
      },
      { type: 'response.completed', response: { usage: {}, output: [] } },
    ])
    const final = out.find(
      (d) => d.kind === 'native_tool' && d.phase === 'completed' && d.sources,
    ) as Extract<StreamDelta, { kind: 'native_tool' }>
    expect(final.sources?.map((s) => s.url)).toEqual([
      'https://a.example.com/x',
      'https://b.example.com/y',
    ])
  })

  it('does NOT extract URLs when no web_search ran (avoids polluting code samples)', async () => {
    const out = await collect([
      {
        type: 'response.output_text.delta',
        delta: 'Visit https://example.com/code for a snippet.',
      },
      { type: 'response.completed', response: { usage: {}, output: [] } },
    ])
    const native = out.find((d) => d.kind === 'native_tool')
    expect(native).toBeUndefined()
  })

  it('strips trailing punctuation and unbalanced parens from URLs', async () => {
    const out = await collect([
      {
        type: 'response.output_item.added',
        item: { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'q' } },
      },
      { type: 'response.web_search_call.completed', item_id: 'ws_1' },
      {
        type: 'response.output_text.delta',
        delta: 'See (https://a.com/x).',
      },
      { type: 'response.completed', response: { usage: {}, output: [] } },
    ])
    const final = out.find(
      (d) => d.kind === 'native_tool' && d.phase === 'completed' && d.sources,
    ) as Extract<StreamDelta, { kind: 'native_tool' }>
    expect(final.sources?.[0]?.url).toBe('https://a.com/x')
  })
})

describe('normalizeResponsesStream — fallback recovery', () => {
  it('recovers final text from response.output when nothing streamed', async () => {
    const out = await collect([
      {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'final answer' },
                { type: 'output_text', text: ' continued' },
              ],
            },
          ],
        },
      },
    ])
    const text = out.find((d) => d.kind === 'text') as Extract<StreamDelta, { kind: 'text' }>
    expect(text.text).toBe('final answer continued')
  })

  it('does NOT recover when streaming text already arrived (avoids double-emit)', async () => {
    const out = await collect([
      { type: 'response.output_text.delta', delta: 'streamed' },
      {
        type: 'response.completed',
        response: {
          usage: {},
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final' }] },
          ],
        },
      },
    ])
    const texts = out.filter((d): d is Extract<StreamDelta, { kind: 'text' }> => d.kind === 'text')
    expect(texts).toEqual([{ kind: 'text', text: 'streamed' }])
  })
})

describe('normalizeResponsesStream — error events', () => {
  it('throws on response.error', async () => {
    await expect(async () => {
      await collect([{ type: 'response.error', error: { message: 'boom' } }])
    }).rejects.toThrow(/Codex stream error/)
  })

  it('throws on bare error', async () => {
    await expect(async () => {
      await collect([{ type: 'error', error: 'kaput' }])
    }).rejects.toThrow(/Codex stream error/)
  })
})

describe('extractCompletedMessageText', () => {
  it('joins multi-chunk message content', () => {
    const text = extractCompletedMessageText([
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'a' },
          { type: 'output_text', text: 'b' },
        ],
      },
    ])
    expect(text).toBe('ab')
  })

  it('skips reasoning / non-message items', () => {
    const text = extractCompletedMessageText([
      { type: 'reasoning', content: [{ type: 'output_text', text: 'thoughts' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'visible' }] },
    ])
    expect(text).toBe('visible')
  })

  it('handles missing content gracefully', () => {
    expect(extractCompletedMessageText([])).toBe('')
    expect(extractCompletedMessageText([{ type: 'message' }])).toBe('')
    expect(extractCompletedMessageText([{ type: 'message', content: [] }])).toBe('')
  })
})
