/**
 * Engine error classification + localized natural-language rendering.
 * Ports apps/server/openhive/engine/errors.py.
 *
 * When a subordinate/tool fails in a way the Lead's LLM might work around,
 * we surface the failure as a `tool_result` with a localized message so a
 * human-quoted error reads right in the user's language.
 *
 * One policy, no user knob: both unattended and manual runs continue
 * gracefully — the Lead LLM receives the error and adapts.
 */

export type Locale = 'en' | 'ko'

// Per-run locale — set by the run entrypoint, read by the error formatter.
// Uses AsyncLocalStorage so concurrent runs don't clobber each other.
import { AsyncLocalStorage } from 'node:async_hooks'

const localeStore = new AsyncLocalStorage<Locale>()

export function withRunLocale<T>(locale: string, fn: () => T): T {
  const loc: Locale = locale === 'ko' ? 'ko' : 'en'
  return localeStore.run(loc, fn)
}

export function currentLocale(): Locale {
  return localeStore.getStore() ?? 'en'
}

export type ErrorClass =
  | 'provider_auth'
  | 'provider_rate_limit'
  | 'provider_model_not_found'
  | 'provider_network'
  | 'provider_unknown'
  | 'agent_excluded'
  | 'tool_runtime'
  | 'unknown'

export interface ClassifiedError {
  kind: ErrorClass
  statusCode: number | null
  detail: string
}

export function classify(exc: unknown): ClassifiedError {
  const msg = exc instanceof Error ? exc.message : String(exc)
  const lower = msg.toLowerCase()

  // Network-level: fetch surfaces these as TypeError('fetch failed') + cause,
  // or AbortError for timeouts. Keep a simple substring check matching the
  // Python httpx-based classifier.
  if (
    lower.includes('fetch failed') ||
    lower.includes('connecttimeout') ||
    lower.includes('readtimeout') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    (exc instanceof Error && exc.name === 'AbortError')
  ) {
    return { kind: 'provider_network', statusCode: null, detail: msg }
  }

  // Providers raise Error with "{name} stream {code}: {body}".
  if (msg.includes('stream 401') || msg.includes('stream 403') || lower.includes('unauthorized')) {
    return { kind: 'provider_auth', statusCode: 401, detail: msg }
  }
  if (msg.includes('stream 429') || lower.includes('rate limit')) {
    return { kind: 'provider_rate_limit', statusCode: 429, detail: msg }
  }
  if (
    msg.includes('stream 404') ||
    (lower.includes('model') && lower.includes('not found'))
  ) {
    return { kind: 'provider_model_not_found', statusCode: 404, detail: msg }
  }
  if (
    msg.includes('stream 5') ||
    msg.includes('stream 502') ||
    msg.includes('stream 503') ||
    msg.includes('stream 504')
  ) {
    return { kind: 'provider_unknown', statusCode: null, detail: msg }
  }

  return { kind: 'tool_runtime', statusCode: null, detail: msg }
}

// ─── Natural-language templates ────────────────────────────────────────────

// Variables available: {role}, {agent}, {provider}, {model}, {detail}.
const TEMPLATES: Record<ErrorClass, Record<Locale, string>> = {
  provider_auth: {
    en:
      "Delegation to {role} failed: authentication with provider '{provider}' " +
      'has expired or is not configured. The user needs to re-authenticate ' +
      'this provider in Settings > Providers before this agent can run. ' +
      'Continue the task by delegating to another subordinate or, if none ' +
      'can cover this work, explain the blocker to the user.',
    ko:
      "{role} 에게 위임 실패: 프로바이더 '{provider}' 의 인증이 만료되었거나 " +
      '설정되지 않았습니다. 사용자가 설정 > 프로바이더에서 재인증해야 이 ' +
      '에이전트를 쓸 수 있습니다. 가능하면 다른 부하 에이전트에게 위임해서 ' +
      '작업을 이어가고, 대체할 수 없으면 사용자에게 상황을 설명해 주세요.',
  },
  provider_rate_limit: {
    en:
      "Delegation to {role} failed: provider '{provider}' rate-limited the " +
      'request after automatic retries. Try delegating to a different agent ' +
      '(preferably one on a different provider) or defer this sub-task.',
    ko:
      "{role} 에게 위임 실패: 프로바이더 '{provider}' 가 자동 재시도 후에도 " +
      '요청 한도를 막았습니다. 다른 프로바이더를 쓰는 부하 에이전트에게 ' +
      '위임하거나 이 하위 작업을 뒤로 미뤄주세요.',
  },
  provider_model_not_found: {
    en:
      "Delegation to {role} failed: model '{model}' is not available on " +
      "provider '{provider}'. This is a configuration issue the user needs " +
      'to fix (pick a different model for this agent). Continue by ' +
      'delegating to a different subordinate if possible.',
    ko:
      "{role} 에게 위임 실패: 모델 '{model}' 이 프로바이더 '{provider}' 에서 " +
      '제공되지 않습니다. 사용자가 이 에이전트의 모델을 바꿔야 하는 설정 ' +
      '문제입니다. 가능하면 다른 부하 에이전트에게 위임해서 진행해 주세요.',
  },
  provider_network: {
    en:
      "Delegation to {role} failed: could not reach provider '{provider}' " +
      '(network error). This may be transient. Consider delegating to a ' +
      'different agent or retrying later.',
    ko:
      "{role} 에게 위임 실패: 프로바이더 '{provider}' 에 연결할 수 없습니다 " +
      '(네트워크 오류). 일시적인 문제일 수 있으니 다른 부하 에이전트에게 ' +
      '위임하거나 나중에 다시 시도해 주세요.',
  },
  provider_unknown: {
    en:
      "Delegation to {role} failed: provider '{provider}' returned an " +
      'unexpected error. Try a different subordinate or report the blocker.',
    ko:
      "{role} 에게 위임 실패: 프로바이더 '{provider}' 가 예상치 못한 오류를 " +
      '반환했습니다. 다른 부하 에이전트를 시도하거나 사용자에게 문제를 ' +
      '보고해 주세요.',
  },
  agent_excluded: {
    en:
      'Delegation to {role} was refused: this agent has already failed 3 ' +
      'times during this run and has been excluded for the remainder of it. ' +
      'You cannot retry this subordinate; route the work elsewhere or ' +
      'explain the gap to the user.',
    ko:
      '{role} 에게 위임 거부됨: 이번 런에서 이미 3회 실패하여 남은 런 동안 ' +
      '이 에이전트는 제외되었습니다. 재시도할 수 없으니 다른 경로로 작업을 ' +
      '돌리거나 사용자에게 공백을 설명해 주세요.',
  },
  tool_runtime: {
    en:
      'Delegation to {role} failed during execution: {detail}. You may ' +
      'rephrase the task and try again, delegate to a different agent, or ' +
      'explain the issue to the user.',
    ko:
      '{role} 실행 중 오류: {detail}. 작업 설명을 바꿔서 재시도하거나, 다른 ' +
      '부하 에이전트에게 위임하거나, 사용자에게 상황을 설명해 주세요.',
  },
  unknown: {
    en: 'Delegation to {role} failed: {detail}.',
    ko: '{role} 에게 위임 실패: {detail}.',
  },
}

function short(s: string, limit = 200): string {
  const t = s.replace(/\n/g, ' ').trim()
  return t.length <= limit ? t : `${t.slice(0, limit - 1)}…`
}

export interface RenderOpts {
  role: string
  agentId: string
  provider: string
  model: string
}

export function renderError(err: ClassifiedError, opts: RenderOpts): string {
  const loc = currentLocale()
  const template =
    TEMPLATES[err.kind]?.[loc] ?? TEMPLATES.unknown[loc] ?? TEMPLATES.unknown.en
  return template
    .replace(/\{role\}/g, opts.role)
    .replace(/\{agent\}/g, opts.agentId)
    .replace(/\{provider\}/g, opts.provider)
    .replace(/\{model\}/g, opts.model)
    .replace(/\{detail\}/g, short(err.detail))
}

// ─── Per-run agent failure counter ─────────────────────────────────────────

/** Hard cap: this many failures in one run and the agent is excluded. */
export const AGENT_FAILURE_CAP = 3

interface FailureState {
  byRun: Map<string, Map<string, number>>
}

const globalForFailures = globalThis as unknown as {
  __openhive_engine_failures?: FailureState
}

function failures(): FailureState {
  if (!globalForFailures.__openhive_engine_failures) {
    globalForFailures.__openhive_engine_failures = { byRun: new Map() }
  }
  return globalForFailures.__openhive_engine_failures
}

export function noteAgentFailure(runId: string, agentId: string): number {
  const byRun = failures().byRun
  let bucket = byRun.get(runId)
  if (!bucket) {
    bucket = new Map()
    byRun.set(runId, bucket)
  }
  const next = (bucket.get(agentId) ?? 0) + 1
  bucket.set(agentId, next)
  return next
}

export function isAgentExcluded(runId: string, agentId: string): boolean {
  const bucket = failures().byRun.get(runId)
  if (!bucket) return false
  return (bucket.get(agentId) ?? 0) >= AGENT_FAILURE_CAP
}

export function clearRunFailures(runId: string): void {
  failures().byRun.delete(runId)
}
