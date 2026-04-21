/**
 * Pending ask_user registry.
 * Ports apps/server/openhive/engine/askuser.py.
 *
 * When the Lead's LLM calls the `ask_user` tool, the engine emits a
 * `user_question` event, registers a pending Promise keyed by tool_call_id,
 * and awaits it. The run stays paused (SSE stream open) until
 * POS../api/sessions/:id/answer resolves the Promise and the answer feeds back
 * as a `tool_result`.
 */

interface PendingEntry<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  done: boolean
}

interface PendingState {
  byCallId: Map<string, PendingEntry<Record<string, unknown>>>
}

const globalForPending = globalThis as unknown as {
  __openhive_askuser_pending?: PendingState
}

function pending(): PendingState {
  if (!globalForPending.__openhive_askuser_pending) {
    globalForPending.__openhive_askuser_pending = { byCallId: new Map() }
  }
  return globalForPending.__openhive_askuser_pending
}

export function register(
  toolCallId: string,
): Promise<Record<string, unknown>> {
  let resolveFn: (v: Record<string, unknown>) => void = () => {}
  let rejectFn: (r?: unknown) => void = () => {}
  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  pending().byCallId.set(toolCallId, {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
    done: false,
  })
  return promise
}

export function resolveAskUser(
  toolCallId: string,
  payload: Record<string, unknown>,
): boolean {
  const entry = pending().byCallId.get(toolCallId)
  if (!entry || entry.done) return false
  entry.done = true
  entry.resolve(payload)
  pending().byCallId.delete(toolCallId)
  return true
}

export function cancelAskUser(toolCallId: string): void {
  const entry = pending().byCallId.get(toolCallId)
  if (!entry) return
  if (!entry.done) {
    entry.done = true
    entry.reject(new Error('cancelled'))
  }
  pending().byCallId.delete(toolCallId)
}
