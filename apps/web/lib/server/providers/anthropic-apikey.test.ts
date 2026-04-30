/**
 * Header / beta-list / refresh-bypass behaviour for the `anthropic` api_key
 * branch of `claude.streamMessages`. Live calls are stubbed via vi.spyOn on
 * the global fetch — we only verify the request shape, never hit the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveToken, deleteToken } from '../tokens'
import * as claude from './claude'

const STUB_KEY = 'sk-ant-api03-PROBETESTKEY1234567890abcdefghi'

function stubFetchOnce(handler: (url: string, init: RequestInit) => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce((url, init) =>
    Promise.resolve(handler(String(url), init ?? {})),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  deleteToken('anthropic')
})

describe('claude.streamMessages with providerId=anthropic', () => {
  it("uses x-api-key header (not Authorization Bearer)", async () => {
    saveToken({
      provider_id: 'anthropic',
      access_token: STUB_KEY,
      refresh_token: null,
      expires_at: null,
      scope: null,
      account_label: 'probe',
      account_id: null,
      created_at: 0,
      updated_at: 0,
    } as never)

    let captured: { headers: Record<string, string> } = { headers: {} }
    stubFetchOnce((_url, init) => {
      captured = { headers: init.headers as Record<string, string> }
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })

    const iter = claude.streamMessages({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      providerId: 'anthropic',
    })
    // drain
    for await (const _ of iter) { /* no-op */ }

    expect(captured.headers['x-api-key']).toBe(STUB_KEY)
    expect(captured.headers['Authorization' as keyof typeof captured.headers]).toBeUndefined()
    expect(captured.headers['anthropic-dangerous-direct-browser-access' as keyof typeof captured.headers])
      .toBeUndefined()
  })

  it("anthropic-beta header excludes claude-code-* and oauth-* but keeps web-search", async () => {
    saveToken({
      provider_id: 'anthropic',
      access_token: STUB_KEY,
      refresh_token: null,
      expires_at: null,
      scope: null,
      account_label: 'probe',
      account_id: null,
      created_at: 0,
      updated_at: 0,
    } as never)

    let beta = ''
    stubFetchOnce((_url, init) => {
      const hs = init.headers as Record<string, string>
      beta = hs['anthropic-beta'] ?? ''
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })

    const iter = claude.streamMessages({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      providerId: 'anthropic',
    })
    for await (const _ of iter) { /* drain */ }

    expect(beta).not.toContain('claude-code-20250219')
    expect(beta).not.toContain('oauth-2025-04-20')
    expect(beta).not.toContain('fast-mode-2026-02-01')
    expect(beta).not.toContain('context-1m-2025-08-07')
    expect(beta).toContain('web-search-2025-03-05')
    expect(beta).toContain('prompt-caching-scope-2026-01-05')
    expect(beta).toContain('interleaved-thinking-2025-05-14')
  })

  it("throws when no anthropic token is stored (refresh is bypassed for api_key)", async () => {
    deleteToken('anthropic')
    await expect(async () => {
      const iter = claude.streamMessages({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        providerId: 'anthropic',
      })
      for await (const _ of iter) { /* drain */ }
    }).rejects.toThrow(/Anthropic is not connected/)
  })
})
