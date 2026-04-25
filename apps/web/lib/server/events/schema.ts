/**
 * Typed event schema. Every engine step emits one or more of these.
 * Ports apps/server/openhive/events/schema.py.
 *
 * Events are persisted to SQLite `session_events` AND fanned out via SSE. The
 * Run-mode canvas and the Timeline tab read from the same stream — no side
 * channels.
 */

export type EventKind =
  | 'run_queued'
  | 'run_started'
  | 'run_finished'
  | 'run_error'
  | 'node_started'
  | 'node_finished'
  | 'node_error'
  | 'token'
  | 'tool_called'
  | 'tool_result'
  | 'delegation_opened'
  | 'delegation_closed'
  | 'checkpoint'
  | 'user_question'
  | 'user_answered'
  | 'user_message'
  | 'turn_finished'
  | 'todos_changed'
  | 'skill.queued'
  | 'skill.started'
  | 'skill.progress'
  | 'tool_run.partitioned'
  // A4 — token estimation + window math
  | 'token.estimate.drift'
  | 'turn.blocked'
  | 'turn.round_limit'
  | 'autocompact.disabled'
  // Round-level observability (multi-round tool-calling turns)
  | 'round_started'
  | 'round_finished'
  | 'provider.empty_round'
  // A2 — lifecycle hooks
  | 'hook.invoked'
  // S3 — parallel fork
  | 'fork.spawned'
  | 'fork.skipped'
  // S2 — microcompact
  | 'microcompact.applied'
  // A3 — artifact rehydration
  | 'artifact.read'
  | 'artifact.read.denied'
  // Provider-side hosted tool lifecycle (Codex web_search, Anthropic
  // server_tool_use). Emitted per phase so the UI can show "🔍 web_search
  // searching…" instead of a blank turn while a 30-150s native search runs.
  | 'native_tool'

export interface Event {
  kind: EventKind
  ts: number
  session_id: string
  depth: number
  node_id: string | null
  tool_call_id: string | null
  tool_name: string | null
  data: Record<string, unknown>
}

export interface MakeEventOpts {
  depth?: number
  node_id?: string | null
  tool_call_id?: string | null
  tool_name?: string | null
}

export function makeEvent(
  kind: EventKind,
  sessionId: string,
  data: Record<string, unknown>,
  opts: MakeEventOpts = {},
): Event {
  return {
    kind,
    ts: Date.now() / 1000,
    session_id: sessionId,
    depth: opts.depth ?? 0,
    node_id: opts.node_id ?? null,
    tool_call_id: opts.tool_call_id ?? null,
    tool_name: opts.tool_name ?? null,
    data,
  }
}
