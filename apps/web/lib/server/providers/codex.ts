/**
 * OpenAI Codex — ChatGPT backend-api Responses endpoint via OAuth.
 * Ports apps/server/openhive/proxy/codex.py.
 *
 * Flow:
 *   - OAuth access_token + refresh_token + chatgpt_account_id in oauth_tokens.
 *   - Refresh via https://auth.openai.com/oauth/token on 60s skew.
 *   - Stream via https://chatgpt.com/backend-api/codex/responses with
 *     OpenAI-Beta: responses=experimental.
 *
 * Messages arrive in the engine's OpenAI-Chat canonical shape and are
 * translated to the Responses API's `instructions` + `input[]` items.
 */

import crypto from 'node:crypto'
import { CLIENT_ID } from '../auth/codex'
import { getAccountLabel, loadToken, saveToken } from '../tokens'
import type { ChatMessage, ToolSpec } from './types'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

interface Session {
  accessToken: string
  accountId: string | null
  expiresAt: number
}

const globalForCache = globalThis as unknown as {
  __openhive_codex_session?: Map<string, Session>
}

function cache(): Map<string, Session> {
  if (!globalForCache.__openhive_codex_session) {
    globalForCache.__openhive_codex_session = new Map()
  }
  return globalForCache.__openhive_codex_session
}

function decodeJwt(t: string): Record<string, unknown> {
  try {
    const parts = t.split('.')
    if (parts.length < 2) return {}
    const payload = parts[1]!
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const decoded = Buffer.from(
      padded.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8')
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function refresh(
  providerId: string,
  refreshToken: string,
): Promise<Session> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    scope: 'openid profile email offline_access',
  })
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(
      `Codex refresh failed (${resp.status}): ${await resp.text()}`,
    )
  }
  const data = (await resp.json()) as Record<string, unknown>
  const access = String(data.access_token ?? '')
  const newRefresh =
    typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken
  const expiresAt = Date.now() / 1000 + Number(data.expires_in ?? 3600)
  const claims = decodeJwt(
    typeof data.id_token === 'string' ? data.id_token : '',
  )
  const oaiAuth = claims['https://api.openai.com/auth']
  let accountId: string | null = null
  if (oaiAuth && typeof oaiAuth === 'object') {
    const v = (oaiAuth as Record<string, unknown>).chatgpt_account_id
    if (typeof v === 'string') accountId = v
  }
  if (!accountId && typeof claims.chatgpt_account_id === 'string') {
    accountId = claims.chatgpt_account_id
  }
  if (!accountId) {
    const existing = loadToken(providerId)
    accountId = existing?.account_id ?? null
  }
  saveToken({
    provider_id: providerId,
    access_token: access,
    refresh_token: newRefresh,
    expires_at: Math.floor(expiresAt),
    scope: typeof data.scope === 'string' ? data.scope : null,
    account_label:
      getAccountLabel(providerId) ??
      (typeof claims.email === 'string' ? claims.email : null),
    account_id: accountId,
  })
  const sess: Session = { accessToken: access, accountId, expiresAt }
  cache().set(providerId, sess)
  return sess
}

async function getSession(providerId = 'codex'): Promise<Session> {
  const now = Date.now() / 1000
  const hit = cache().get(providerId)
  if (hit && hit.expiresAt - 60 > now && hit.accountId) return hit
  const record = loadToken(providerId)
  if (!record) {
    throw new Error('Codex is not connected. Connect it in Settings first.')
  }
  if (
    record.expires_at &&
    record.expires_at - 60 > now &&
    record.account_id
  ) {
    const sess: Session = {
      accessToken: record.access_token,
      accountId: record.account_id,
      expiresAt: record.expires_at,
    }
    cache().set(providerId, sess)
    return sess
  }
  if (!record.refresh_token) {
    return {
      accessToken: record.access_token,
      accountId: record.account_id,
      expiresAt: now + 300,
    }
  }
  return refresh(providerId, record.refresh_token)
}

// -------- format translation --------

interface ResponseInputItem {
  type: string
  role?: string
  content?: { type: string; text: string }[]
  call_id?: string
  output?: string
  name?: string
  arguments?: string
}

function toResponsesInput(
  messages: ChatMessage[],
): { system: string | null; items: ResponseInputItem[] } {
  let system: string | null = null
  const items: ResponseInputItem[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      system = (system ? `${system}\n\n` : '') + (m.content ?? '')
      continue
    }
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: typeof m.content === 'string' ? m.content : '',
      })
      continue
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        })
      }
      for (const tc of m.tool_calls ?? []) {
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        })
      }
      continue
    }
    items.push({
      type: 'message',
      role: m.role ?? 'user',
      content: [
        {
          type: 'input_text',
          text: typeof m.content === 'string' ? m.content : '',
        },
      ],
    })
  }
  return { system, items }
}

function toolsToResponses(tools: ToolSpec[] | undefined): unknown[] | null {
  if (!tools || tools.length === 0) return null
  return tools.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: t.function.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }))
}

// -------- streaming --------

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  while (true) {
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
        yield JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* skip malformed chunks */
      }
    }
  }
}

export interface StreamOpts {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  providerId?: string
}

export async function* streamResponses(
  opts: StreamOpts,
): AsyncIterable<Record<string, unknown>> {
  const providerId = opts.providerId ?? 'codex'
  const session = await getSession(providerId)
  const { system, items } = toResponsesInput(opts.messages)
  const respTools = toolsToResponses(opts.tools)

  const instructions =
    (system ?? '').trim() ||
    "You are Codex, a helpful coding assistant. Follow the user's request directly."

  const payload: Record<string, unknown> = {
    model: opts.model,
    input: items,
    instructions,
    stream: true,
    store: false,
    parallel_tool_calls: false,
    reasoning: { effort: 'low', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  }
  if (respTools) {
    payload.tools = respTools
    payload.tool_choice = 'auto'
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    'User-Agent': 'codex-cli/1.0.18 (macOS; arm64)',
    session_id: crypto.randomUUID(),
  }
  if (session.accountId) headers['chatgpt-account-id'] = session.accountId

  const resp = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok || !resp.body) {
    const body = resp.body ? await resp.text() : ''
    throw new Error(`Codex responses ${resp.status}: ${body}`)
  }
  yield* sseEvents(resp.body)
}
