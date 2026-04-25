/** Dump every event type Codex emits during a web_search-enabled stream
 *  so we can find where the actual citation/source data lives.
 *  Codex Responses API doesn't always use OpenAI's `response.output_text
 *  .annotation.added` shape — sometimes citations come on the search-call
 *  item itself (`output_item.done.item.action.sources`), sometimes nested
 *  under different event names. This is a one-shot diagnostic. */

import * as codex from '../lib/server/providers/codex'

async function main(): Promise<void> {
  const counts = new Map<string, number>()
  const examples = new Map<string, unknown>()
  let citationFields = 0
  for await (const ev of codex.streamResponses({
    model: 'gpt-5.5',
    messages: [
      {
        role: 'user',
        content: 'Search the web for the latest OpenAI GPT-5.5 release news (April 2026) and cite 2-3 sources.',
      },
    ],
    tools: [],
    sessionId: 'native-events-probe',
    nativeWebSearch: true,
  })) {
    const t = String((ev as { type?: unknown }).type ?? 'unknown')
    counts.set(t, (counts.get(t) ?? 0) + 1)
    if (!examples.has(t)) examples.set(t, ev)
    const s = JSON.stringify(ev)
    if (s.includes('citation') || s.includes('url') || s.includes('annotation')) {
      citationFields++
      if (citationFields <= 6) {
        console.log('--- citation/url/annotation:', t, '---')
        console.log(s.slice(0, 600))
      }
    }
    if (t === 'response.completed' || t === 'response.done') break
  }
  console.log('\n--- counts ---')
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(3)} ${k}`)
  }

  // Dump full payload of likely-relevant events
  for (const t of [
    'response.output_item.done',
    'response.output_text.annotation.added',
    'response.web_search_call.completed',
  ]) {
    const ex = examples.get(t)
    if (ex) {
      console.log(`\n--- example ${t} ---`)
      console.log(JSON.stringify(ex).slice(0, 1200))
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
