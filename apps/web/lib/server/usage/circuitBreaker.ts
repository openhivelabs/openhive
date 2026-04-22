/**
 * Auto-compact circuit breaker — scaffold only.
 *
 * Tracks consecutive auto-compact failures per session in memory. Three
 * consecutive failures disables auto-compact for the remainder of the
 * session. State lives on globalThis so HMR / tsx watch don't reset the
 * counter mid-run.
 *
 * NOTE: Helpers are exported but NOT wired up in this round. The auto-compact
 * implementation spec will call `recordAutoCompactFailure` /
 * `recordAutoCompactSuccess` at the right moments. Until then these are
 * intentionally dead code (verified via no-unused-exports audit at wiring
 * time). Do not add callers in this PR.
 */

const GLOBAL_KEY = Symbol.for('openhive.usage.circuitBreaker')

interface SessionState {
  consecutiveFailures: number
  disabled: boolean
}

interface Store {
  bySession: Map<string, SessionState>
}

function store(): Store {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: Store }
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { bySession: new Map() }
  }
  return g[GLOBAL_KEY] as Store
}

function getOrInit(sessionId: string): SessionState {
  const s = store()
  let row = s.bySession.get(sessionId)
  if (!row) {
    row = { consecutiveFailures: 0, disabled: false }
    s.bySession.set(sessionId, row)
  }
  return row
}

const FAIL_LIMIT = 3

export interface FailureResult {
  disabled: boolean
  failures: number
}

export function recordAutoCompactFailure(sessionId: string): FailureResult {
  const row = getOrInit(sessionId)
  row.consecutiveFailures += 1
  if (row.consecutiveFailures >= FAIL_LIMIT) row.disabled = true
  return { disabled: row.disabled, failures: row.consecutiveFailures }
}

export function recordAutoCompactSuccess(sessionId: string): void {
  const row = store().bySession.get(sessionId)
  if (row) row.consecutiveFailures = 0
}

export function isAutoCompactDisabled(sessionId: string): boolean {
  return store().bySession.get(sessionId)?.disabled ?? false
}

export function resetAutoCompactState(sessionId: string): void {
  store().bySession.delete(sessionId)
}
