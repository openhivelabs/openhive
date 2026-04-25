/**
 * Probe whether each provider's backend accepts a server-side `web_search`
 * builtin tool. Uses the same OAuth tokens as the running app — no separate
 * auth — and makes a single real request per provider, dumping the response
 * status + first few SSE events / JSON keys so we can see whether the tool
 * was accepted or rejected. Exits 0 even on per-provider failure; the goal
 * is a probe report, not a build gate.
 *
 * Run: pnpm tsx apps/web/scripts/probe-native-web-search.ts
 */

import { loadToken } from '../lib/server/tokens'

const QUERY = 'OpenAI GPT-5.5 release April 2026'

function shortError(body: string): string {
  // Most provider errors come back as JSON; trim to first 600 chars so we
  // see the message without spamming the terminal with a stack trace.
  return body.length > 600 ? body.slice(0, 600) + '…' : body
}

async function probeCodex(toolType: 'web_search' | 'web_search_preview'): Promise<void> {
  const tok = loadToken('codex')
  if (!tok) {
    console.log(`[codex/${toolType}] NO TOKEN — run /providers/codex auth first`)
    return
  }
  const payload = {
    model: 'gpt-5.5',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `Search the web for: ${QUERY}` }],
      },
    ],
    instructions: 'You are a search assistant. Use the web_search tool.',
    tools: [{ type: toolType }],
    stream: true,
    store: false,
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tok.access_token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    'User-Agent': 'codex-cli/1.0.18 (macOS; arm64)',
    session_id: crypto.randomUUID(),
  }
  if (tok.account_id) headers['chatgpt-account-id'] = tok.account_id

  const t0 = Date.now()
  let resp: Response
  try {
    resp = await fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (e) {
    console.log(`[codex/${toolType}] FETCH ERROR ${(e as Error).message}`)
    return
  }
  console.log(`\n[codex/${toolType}] HTTP ${resp.status} ${resp.statusText} (${Date.now() - t0}ms)`)
  if (!resp.ok || !resp.body) {
    const body = await resp.text().catch(() => '')
    console.log(`  err: ${shortError(body)}`)
    return
  }
  // Stream and capture event types. Stop after first 4s of events or 12 events.
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const seenTypes = new Map<string, number>()
  let toolUseBlocks: unknown[] = []
  const deadline = Date.now() + 30_000
  let totalEvents = 0
  outer: while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue
      try {
        const ev = JSON.parse(raw) as Record<string, unknown>
        const t = String(ev.type ?? '')
        seenTypes.set(t, (seenTypes.get(t) ?? 0) + 1)
        totalEvents++
        // Capture tool-use & web-search-related blocks
        if (t.includes('web_search') || t.includes('tool')) {
          toolUseBlocks.push(ev)
        }
        if (t === 'response.completed' || t === 'response.done') break outer
        if (totalEvents > 60) break outer
      } catch {
        /* skip */
      }
    }
  }
  await reader.cancel().catch(() => {})
  console.log(`  events: ${totalEvents} kinds=${JSON.stringify(Object.fromEntries(seenTypes))}`)
  if (toolUseBlocks.length > 0) {
    console.log(`  tool-related events:`)
    for (const b of toolUseBlocks.slice(0, 5)) {
      console.log(`    ${JSON.stringify(b).slice(0, 220)}`)
    }
  }
}

async function probeCopilot(): Promise<void> {
  const tok = loadToken('copilot')
  if (!tok) {
    console.log(`[copilot] NO TOKEN — run /providers/copilot auth first`)
    return
  }
  // Copilot uses /chat/completions style. OpenAI builtin web_search has been
  // added to the standard chat-completions API recently as `web_search`. We
  // try both names; if Copilot rejects either we'll see it in the error.
  for (const toolType of ['web_search', 'web_search_preview']) {
    const payload = {
      model: 'gpt-5-mini',
      messages: [
        { role: 'user', content: `Search the web for: ${QUERY}` },
      ],
      tools: [{ type: toolType }],
      stream: false,
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tok.access_token}`,
      'Content-Type': 'application/json',
      'Editor-Version': 'vscode/1.97.0',
      'Editor-Plugin-Version': 'copilot-chat/0.22.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'X-Github-Api-Version': '2025-04-01',
    }
    const t0 = Date.now()
    let resp: Response
    try {
      resp = await fetch('https://api.githubcopilot.com/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      console.log(`[copilot/${toolType}] FETCH ERROR ${(e as Error).message}`)
      continue
    }
    const body = await resp.text().catch(() => '')
    console.log(`\n[copilot/${toolType}] HTTP ${resp.status} (${Date.now() - t0}ms)`)
    console.log(`  body: ${shortError(body)}`)
  }
}

async function probeClaude(): Promise<void> {
  const tok = loadToken('claude')
  if (!tok) {
    console.log(`\n[claude] NO TOKEN — Anthropic provider not connected (skip)`)
    return
  }
  const payload = {
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `Search the web for: ${QUERY}` }],
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
    ],
    stream: false,
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tok.access_token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'web-search-2025-03-05',
  }
  const t0 = Date.now()
  let resp: Response
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (e) {
    console.log(`[claude] FETCH ERROR ${(e as Error).message}`)
    return
  }
  const body = await resp.text().catch(() => '')
  console.log(`\n[claude] HTTP ${resp.status} (${Date.now() - t0}ms)`)
  console.log(`  body: ${shortError(body)}`)
}

async function main(): Promise<void> {
  console.log(`Probing native web_search tool support across providers.`)
  console.log(`Query: "${QUERY}"\n`)

  await probeCodex('web_search')
  await probeCodex('web_search_preview')
  await probeCopilot()
  await probeClaude()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
