/**
 * Hook type definitions — MVP (SessionStart / PreToolUse / Stop).
 * See dev/active/runtime-claude-patterns/a2-hooks.md for the authority spec.
 */

import type { Event } from '../events/schema'

export type HookEventName = 'SessionStart' | 'PreToolUse' | 'Stop'

export interface HookEntry {
  matcher: string
  command: string
  timeout: number
}

export interface HookConfig {
  SessionStart: HookEntry[]
  PreToolUse: HookEntry[]
  Stop: HookEntry[]
}

/** Parsed stdout JSON contract from `exit 0` hooks. All fields optional. */
export interface HookStdoutPayload {
  continue?: boolean
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  additionalContext?: string
  suppressOutput?: boolean
  hookSpecificOutput?: Record<string, unknown>
}

export interface HookOutcome {
  invoked: number
  decision: 'approve' | 'block' | null
  reason: string | null
  systemMessage: string | null
  additionalContext: string | null
  continueChain: boolean
  /**
   * Events to be yielded by the caller into the outer generator. `runHooks`
   * is a Promise not a generator, so we collect `hook.invoked` events here
   * and let the engine `for (const e of outcome.events) yield e` them.
   */
  events: Event[]
}

interface CommonHookPayload {
  hook_event_name: HookEventName
  session_id: string
  transcript_path: string
  cwd: string
  company_id: string | null
  team_id: string
  data_dir: string
}

export interface SessionStartPayload extends CommonHookPayload {
  hook_event_name: 'SessionStart'
  goal: string
  team_snapshot: unknown
  source: 'fresh' | 'resume'
}

export interface PreToolUsePayload extends CommonHookPayload {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  agent_id: string
  depth: number
  tool_call_id: string
}

export interface StopPayload extends CommonHookPayload {
  hook_event_name: 'Stop'
  status: 'completed' | 'error' | 'idle'
  duration_ms: number
  artifact_paths: string[]
  last_event_seq: number
  output: string | null
  error: string | null
}

export type HookPayload = SessionStartPayload | PreToolUsePayload | StopPayload

export interface RunOneResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}
