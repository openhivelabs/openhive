/**
 * Public hook entry point. Engine callers do:
 *
 *   const outcome = await runHooks('PreToolUse', toolName, payload)
 *   for (const e of outcome.events) yield e
 *   if (outcome.decision === 'block') { ... }
 *
 * Zero-config path: if no entries match, `invoked === 0` and zero child
 * processes are spawned.
 */

import { makeEvent } from '../events/schema'
import type { Event } from '../events/schema'
import { getHookConfig } from './config'
import { matchHooks } from './matcher'
import { type RunOneEnvExtras, runOne } from './runner'
import type { HookEventName, HookOutcome, HookPayload, HookStdoutPayload } from './types'

const ADDITIONAL_CONTEXT_CAP = 8192
const REASON_CAP = 2048

export interface RunHooksOpts {
  /**
   * When provided, used as the `session_id` for the synthesised `hook.invoked`
   * events appended to the outcome. Most callers pass the same id that's in
   * the payload; kept explicit so `runHooks` doesn't need to crack the payload
   * back open.
   */
  sessionId: string
}

export async function runHooks(
  event: HookEventName,
  matchTarget: string,
  payload: HookPayload,
  opts: RunHooksOpts,
): Promise<HookOutcome> {
  const outcome: HookOutcome = {
    invoked: 0,
    decision: null,
    reason: null,
    systemMessage: null,
    additionalContext: null,
    continueChain: true,
    events: [],
  }

  const cfg = getHookConfig()
  const allForEvent = cfg[event]
  if (!allForEvent || allForEvent.length === 0) return outcome
  const entries = matchHooks(event, matchTarget, allForEvent)
  if (entries.length === 0) return outcome

  const additionalContextBuf: string[] = []

  const envExtras: RunOneEnvExtras = {
    OPENHIVE_HOOK_EVENT: event,
    OPENHIVE_SESSION_ID: payload.session_id,
    OPENHIVE_COMPANY_ID: payload.company_id ?? '',
    OPENHIVE_TEAM_ID: payload.team_id,
    OPENHIVE_TRANSCRIPT_PATH: payload.transcript_path,
  }

  for (const entry of entries) {
    const t0 = Date.now()
    const res = await runOne(entry, payload, envExtras)
    outcome.invoked += 1

    let parsed: HookStdoutPayload = {}
    if (res.exitCode === 0 && res.stdout.trim().length > 0) {
      try {
        const maybe = JSON.parse(res.stdout)
        if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) {
          parsed = maybe as HookStdoutPayload
        }
      } catch {
        /* swallow — plain-text stdout is fine for "notify-only" hooks */
      }
    }

    let decisionThisHook: 'approve' | 'block' | null = null
    if (res.exitCode === 2) {
      decisionThisHook = 'block'
      const msg = res.stderr.slice(0, REASON_CAP).trim()
      outcome.reason = msg.length > 0 ? msg : outcome.reason
    } else if (res.exitCode === 0 && parsed.decision) {
      decisionThisHook = parsed.decision
      if (parsed.reason) outcome.reason = parsed.reason.slice(0, REASON_CAP)
    } else if (res.exitCode !== 0 && res.exitCode !== 2) {
      console.warn(
        `[hooks] ${entry.command} exited ${res.exitCode} (timedOut=${res.timedOut}): ${res.stderr.slice(0, 256)}`,
      )
    }

    if (decisionThisHook) outcome.decision = decisionThisHook
    if (parsed.systemMessage) outcome.systemMessage = parsed.systemMessage
    if (parsed.additionalContext) additionalContextBuf.push(parsed.additionalContext)
    if (parsed.continue === false) outcome.continueChain = false

    outcome.events.push(
      makeEvent('hook.invoked', opts.sessionId, {
        event_name: event,
        matcher: entry.matcher,
        command: entry.command,
        exit_code: res.exitCode,
        duration_ms: Date.now() - t0,
        timed_out: res.timedOut,
        decision: decisionThisHook,
      }),
    )

    if (!outcome.continueChain) break
  }

  if (additionalContextBuf.length > 0) {
    let merged = additionalContextBuf.join('\n\n')
    if (merged.length > ADDITIONAL_CONTEXT_CAP) {
      console.warn(`[hooks] additionalContext > ${ADDITIONAL_CONTEXT_CAP} chars, truncating`)
      merged = merged.slice(0, ADDITIONAL_CONTEXT_CAP)
    }
    outcome.additionalContext = merged
  }

  return outcome
}

export type { HookEventName, HookOutcome, HookPayload } from './types'
export { getHookConfig, hooksDisabled } from './config'
export { matchHooks, matchesGlob, globToRegex } from './matcher'

// Re-export for tests.
export { __resetHookConfigCacheForTests } from './config'

// Helper: synthesise a bare `Event` for callers that want to emit their own
// hook-related events (not used by runHooks itself).
export function makeHookEvent(sessionId: string, data: Record<string, unknown>): Event {
  return makeEvent('hook.invoked', sessionId, data)
}
