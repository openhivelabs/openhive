/** Engine provider dispatch matrix — confirms each providerId routes to the
 *  right adapter (or throws for unwired ones). We swap fetch and the codex /
 *  copilot session helpers via vi.spyOn so no live network is required. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveToken, deleteToken } from '../tokens'
import { stream } from './providers'

const ANTHROPIC_KEY = 'sk-ant-api03-DISPATCHTEST1234567890ABCDEFG'

afterEach(() => {
  vi.restoreAllMocks()
  deleteToken('anthropic')
  deleteToken('claude-code')
})

function stubSseOk(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    ),
  )
}

describe('engine.stream dispatch', () => {
  it("routes providerId='anthropic' to streamClaude with x-api-key header", async () => {
    saveToken({
      provider_id: 'anthropic',
      access_token: ANTHROPIC_KEY,
      refresh_token: null,
      expires_at: null,
      scope: null,
      account_label: 'test',
      account_id: null,
      created_at: 0,
      updated_at: 0,
    } as never)

    let xApiKey: string | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const hs = (init as RequestInit).headers as Record<string, string>
      xApiKey = hs['x-api-key']
      return Promise.resolve(
        new Response(
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    })

    const it = stream('anthropic', 'claude-haiku-4-5', [{ role: 'user', content: 'hi' }], undefined)
    for await (const _delta of it) { /* drain */ }

    expect(xApiKey).toBe(ANTHROPIC_KEY)
  })

  it("routes providerId='openai' to streamOpenAI (throws on missing token, not 'not yet wired')", async () => {
    deleteToken('openai')
    await expect(async () => {
      const it = stream('openai', 'gpt-5.5', [{ role: 'user', content: 'hi' }], undefined)
      for await (const _ of it) { /* drain */ }
    }).rejects.toThrow(/OpenAI is not connected/)
  })

  it("routes providerId='gemini' to streamGemini (throws on missing token, not 'not yet wired')", async () => {
    deleteToken('gemini')
    await expect(async () => {
      const it = stream('gemini', 'gemini-3.1-pro-preview', [{ role: 'user', content: 'hi' }], undefined)
      for await (const _ of it) { /* drain */ }
    }).rejects.toThrow(/Gemini is not connected/)
  })

  it("routes providerId='vertex-ai' to streamVertex (throws on missing token, not 'not yet wired')", async () => {
    deleteToken('vertex-ai')
    await expect(async () => {
      const it = stream('vertex-ai', 'gemini-3.1-pro-preview', [{ role: 'user', content: 'hi' }], undefined)
      for await (const _ of it) { /* drain */ }
    }).rejects.toThrow(/Vertex AI is not connected/)
  })
})
