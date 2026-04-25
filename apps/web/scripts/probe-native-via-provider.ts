/**
 * End-to-end check that the engine→provider plumbing actually injects
 * `{type: "web_search"}` into Codex requests when `nativeWebSearch: true`.
 * Calls `codex.streamResponses` directly (no skill fallback wiring) and
 * counts the web_search-related SSE events. Pass = at least one
 * `response.web_search_call.completed` arrives.
 */

import * as codex from '../lib/server/providers/codex'

async function main(): Promise<void> {
  const events: string[] = []
  let textChars = 0
  for await (const ev of codex.streamResponses({
    model: 'gpt-5.5',
    messages: [
      {
        role: 'user',
        content: 'Search the web for "OpenAI GPT-5.5 release April 2026" and summarize in one sentence.',
      },
    ],
    tools: [],
    sessionId: 'native-web-search-probe',
    nativeWebSearch: true,
  })) {
    const t = String((ev as { type?: unknown }).type ?? '')
    events.push(t)
    if (t === 'response.output_text.delta') {
      const d = (ev as { delta?: unknown }).delta
      if (typeof d === 'string') textChars += d.length
    }
    if (t === 'response.completed' || t === 'response.done') break
  }

  const counts = events.reduce<Record<string, number>>((acc, t) => {
    acc[t] = (acc[t] ?? 0) + 1
    return acc
  }, {})

  const sawSearch =
    (counts['response.web_search_call.completed'] ?? 0) > 0
  console.log(`provider-path probe: events=${events.length} text=${textChars}ch`)
  console.log(`web_search events: ${JSON.stringify(
    Object.fromEntries(
      Object.entries(counts).filter(([k]) => k.includes('web_search')),
    ),
  )}`)
  console.log(sawSearch ? 'PASS — native web_search ran via provider code' : 'FAIL — no web_search events seen')
  process.exit(sawSearch ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
