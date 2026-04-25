/**
 * Engine runner — async orchestrator.
 * Ports apps/server/openhi../engine/session.py (~1400 LOC).
 *
 * Pipeline per run:
 *   1. Start at the entry agent (Lead) with the user's goal.
 *   2. For each node: build tools (delegate_to + subordinates + skills + MCP +
 *      ask_user + team-data). Stream from the provider. Emit token events.
 *   3. If the model calls tools, execute them (delegation recursively runs a
 *      subordinate node), append tool_result messages, loop.
 *   4. When the node stops without tool calls, emit node_finished.
 *   5. The Lead's final text is the run's output.
 *
 * Every event is yielded so the SSE endpoint can forward it live. Persistence
 * into run_events happens at the registry layer, not here.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import pLimit from 'p-limit'
import {
  composePersonaBody,
  effectiveMcpServers,
  effectiveSkills,
  makePersonaTools,
  resolvePersona,
} from '../agents/runtime'
import * as artifactsStore from '../artifacts'
import { getSettings } from '../config'
import { type Event, makeEvent } from '../events/schema'
import { runHooks } from '../hooks'
import { isLedgerDisabled } from '../ledger/db'
import { ledgerTools } from '../ledger/tools'
import { maybeWriteLedger } from '../ledger/write'
import { dataDir } from '../paths'
import type { ChatMessage, ToolSpec } from '../providers/types'
import { readArtifactTool, buildArtifactUri } from '../sessions/artifacts'
import * as sessionsStore from '../sessions'
import { type SkillDef, getSkill, listSkills, matchSkillHints } from '../skills/loader'
import { readSkillFile, runSkill, runSkillScript } from '../skills/runner'
import { type Tool, toolsToOpenAI } from '../tools/base'
import { teamDataTools } from '../tools/team-data-tool'
import { effectiveWindow as computeEffectiveWindow } from '../usage/contextWindow'
import {
  estimateMessagesTokens,
  estimateTextTokens,
  estimateToolsTokens,
  shouldBlockTurn,
} from '../usage/tokens'
import { type ThresholdTrigger, recordUsage } from '../usage'
import * as askuser from './askuser'
import * as errors from './errors'
import {
  buildForkedMessages,
  decideForkOrFresh,
  type TurnSnapshot,
} from './fork'
import { maybeMicrocompact } from './microcompact'
import { stream, buildMessages } from './providers'
import {
  MAX_CHILD_RESULT_CHARS,
  type SummaryStrategy,
  capAndSummarise,
} from './result-cap'
import type { AgentSpec, TeamSpec } from './team'
import { entryAgent, subordinates as teamSubordinates } from './team'
import {
  PARALLEL_TRAJECTORY_TOOLS,
  TRAJECTORY_TOOLS,
  type ToolRun,
  partitionRuns,
} from './tool-partition'
import {
  appendArtifactBlock,
  getRealArtifactUriSet,
  renderSessionArtifacts,
  toManifestEntry,
} from './artifacts-manifest'
import {
  askUserGuidance,
  delegateToGuidance,
  activateSkillGuidance,
  listSkillFilesGuidance,
} from './delegation-guidance'
import { stripFakeArtifactLinks, stripMetaLabels } from './post-process'

// Guard defaults + hard ceilings. The per-turn caps below are fallbacks for
// sessions that predate `team.limits` (serialized snapshots from older runs)
// — new sessions always pull the resolved value from the team snapshot.
export const MAX_TOOL_ROUNDS = 8
export const MAX_DEPTH = 4
export const MAX_ASK_USER_PER_TURN_FALLBACK = 4
export const HARD_MAX_TOOL_ROUNDS = 30
export const HARD_MAX_DEPTH = 8

/** Tool names that mutate run-scoped state (delegation tree, ask_user
 *  counter, todos) — these must execute serially. Every other tool (MCP,
 *  skill helpers, custom handlers) is parallel-safe in a single turn.
 *
 *  Back-compat set used by the legacy `splitToolRuns` partitioner (active
 *  only when `OPENHIVE_TOOL_PARTITION_V2=0`). This union preserves the
 *  PRE-split "delegate_to is serial" behaviour so the env rollback is a
 *  faithful bisect to pre-parallel-delegate code. The v2 path has moved
 *  `delegate_to` into `PARALLEL_TRAJECTORY_TOOLS` for cross-subordinate
 *  fan-out. */
export const SERIAL_TOOL_NAMES = new Set<string>([
  ...TRAJECTORY_TOOLS,
  ...PARALLEL_TRAJECTORY_TOOLS,
])

/** Partition tool_calls into consecutive serial/parallel runs. Adjacent
 *  same-kind calls collapse into one run; the order inside each run is
 *  preserved so provider history remains deterministic.
 *
 *  Legacy v1 partitioner. Used as fallback when
 *  `OPENHIVE_TOOL_PARTITION_V2=0`. The default path now goes through
 *  `partitionRuns` from `./tool-partition` (3-class taxonomy + cap). */
export function splitToolRuns<T extends { function: { name: string } }>(
  calls: T[],
): { serial: boolean; items: T[] }[] {
  const runs: { serial: boolean; items: T[] }[] = []
  for (const tc of calls) {
    const serial = SERIAL_TOOL_NAMES.has(tc.function.name)
    const last = runs[runs.length - 1]
    if (last && last.serial === serial) last.items.push(tc)
    else runs.push({ serial, items: [tc] })
  }
  return runs
}

/** Env: v2 partition + concurrency cap is default ON. Set
 *  `OPENHIVE_TOOL_PARTITION_V2=0` to fall back to legacy `splitToolRuns`. */
function toolPartitionV2Enabled(): boolean {
  return process.env.OPENHIVE_TOOL_PARTITION_V2 !== '0'
}

/** Env: per-parallel-bucket concurrency cap for safe_parallel tools
 *  (web_fetch / sql_query / read_skill_file / MCP reads). Default 10. */
function toolParallelMax(): number {
  const raw = Number(process.env.OPENHIVE_TOOL_PARALLEL_MAX)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10
}

/** Env: concurrency cap for parallel_trajectory buckets (currently just
 *  `delegate_to` fan-out across different subordinates in one assistant
 *  turn). Default 4. Kept smaller than toolParallelMax because each slot
 *  fires an LLM stream — overshooting blows provider rate limits and
 *  token budget, unlike cheap I/O in safe_parallel. Set to 1 to force
 *  legacy serial behaviour (useful as a regression bisect). */
function parallelDelegationMax(): number {
  const raw = Number(process.env.OPENHIVE_PARALLEL_DELEGATION_MAX)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4
}

// session_id → counters kept on globalThis so HMR doesn't drop in-flight runs.
export interface TodoItem {
  id: string
  text: string
  done: boolean
}
interface RunState {
  askUser: Map<string, number>
  teamSlugs: Map<string, [string, string]>
  semaphore: Semaphore | null
  // `{sessionId}:{fromId}->{toId}` → count. Phase C1 loop guard.
  delegations: Map<string, number>
  // sessionId → count of read_skill_file calls (any skill/path). Phase C3 cap.
  readSkillFileTotal: Map<string, number>
  // sessionId → set of `{skill}:{path}` already read. Phase C3 dedupe.
  readSkillFileSeen: Map<string, Set<string>>
  // sessionId → count of `web-search` calls this turn. Prevents runaway
  // search loops (LLM re-queries 20+ times when results aren't perfect).
  webSearch: Map<string, number>
  // sessionId → ordered todo list maintained by the Lead via native tools.
  todos: Map<string, TodoItem[]>
  // S3 fork: sessionId → last-turn snapshot captured at streamTurn entry.
  // Parallel delegation reads this so sibling children's first turn is
  // byte-identical with the parent's prefix (prompt-cache hit).
  lastTurnSnapshot: Map<string, TurnSnapshot>
  // S3 fork: reserved for a future LRU of serialized system prompts keyed
  // by `${sessionId}:${nodeId}:${depth}:${todoVersion}`. Not consumed yet —
  // fork children currently inherit the parent's snapshot.systemPrompt.
  forkSystemCache: Map<string, string>
}

// Phase C1: Cap per-(parent→child) delegations within a TURN. A parent re-
// delegating the same sub-agent 5+ times in one burst almost always means
// "REVISED TASK" spam. Fallback only — resolved value comes from
// team.limits.max_delegations_per_pair_per_turn.
export const MAX_DELEGATIONS_PER_PAIR_FALLBACK = 4

// Phase C3: Cap read_skill_file. Once a skill is activated the LLM tends to
// spelunk its entire tree looking for answers it already has. Same-file reads
// are always redundant; total cap stops fan-out sprees mid-turn. Fallback
// only — resolved from team.limits.max_read_skill_file_per_turn.
export const MAX_READ_SKILL_FILE_PER_TURN_FALLBACK = 8

// Phase C4: Cap `web-search` calls per turn. Claude Code hardcaps at 8; we
// scale down to 5 because our multi-agent fan-out (Lead + researcher siblings)
// multiplies query volume. Without this the LLM loops on "just one more
// search" when results aren't perfect. Fallback only — resolved from
// team.limits.max_web_search_per_turn.
export const MAX_WEB_SEARCH_PER_TURN_FALLBACK = 5

const globalForRun = globalThis as unknown as {
  __openhive_engine_run?: RunState
}

function state(): RunState {
  if (!globalForRun.__openhive_engine_run) {
    globalForRun.__openhive_engine_run = {
      askUser: new Map(),
      teamSlugs: new Map(),
      semaphore: null,
      delegations: new Map(),
      readSkillFileTotal: new Map(),
      readSkillFileSeen: new Map(),
      webSearch: new Map(),
      todos: new Map(),
      lastTurnSnapshot: new Map(),
      forkSystemCache: new Map(),
    }
  }
  // HMR-safe: if an older incarnation initialised the global without a newer
  // field, backfill it instead of crashing with "undefined.get".
  const s = globalForRun.__openhive_engine_run
  if (!s.delegations) s.delegations = new Map()
  if (!s.readSkillFileTotal) s.readSkillFileTotal = new Map()
  if (!s.readSkillFileSeen) s.readSkillFileSeen = new Map()
  if (!s.webSearch) s.webSearch = new Map()
  if (!s.todos) s.todos = new Map()
  if (!s.lastTurnSnapshot) s.lastTurnSnapshot = new Map()
  if (!s.forkSystemCache) s.forkSystemCache = new Map()
  return s
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`
}

/** 세션 ID 는 외부(URL · meta.json · 이벤트 스트림 · 스토리지 경로)로 노출되므로
 *  충돌 가능성 낮고 외부 시스템과 호환 좋은 uuid v4 를 쓴다. 내부 id(tool_call,
 *  sibling, todo) 들은 prefix 형태 유지. */
function newSessionId(): string {
  return crypto.randomUUID()
}

/** Give a delegation slot back to the per-turn counter. Called when a sub
 *  delegation ended up being a no-op (no tool calls, just a clarifying-
 *  question bounce) or crashed before doing any work — in both cases the
 *  parent legitimately needs another slot to retry or fix the task itself. */
function refundDelegationSlot(pairKey: string): void {
  const cur = state().delegations.get(pairKey) ?? 0
  if (cur > 0) state().delegations.set(pairKey, cur - 1)
}

/** Drop per-turn cap counters for `sessionId` so the next user turn starts
 *  with a fresh budget. Call when `inbox.pop()` yields a new user message —
 *  the previous turn is done, a re-delegation or re-ask in the new turn is
 *  a legitimate follow-up, not loop spam. Only touches keys scoped to this
 *  session; other in-flight sessions keep their counters. */
function resetPerTurnCaps(sessionId: string): void {
  const s = state()
  for (const k of s.delegations.keys()) {
    if (k.startsWith(`${sessionId}:`)) s.delegations.delete(k)
  }
  s.askUser.set(sessionId, 0)
  s.readSkillFileTotal.delete(sessionId)
  const seen = s.readSkillFileSeen.get(sessionId)
  if (seen) seen.clear()
  s.webSearch.delete(sessionId)
}

// -------- history compaction helpers (Phase B token savings) --------

/** Walk the history, build a tool_call_id → (name, args) map from assistant
 *  messages. Used by the elision helpers below — the tool-role rows don't
 *  carry the tool name themselves. */
function indexToolCalls(history: ChatMessage[]): Map<string, { name: string; args: string }> {
  const out = new Map<string, { name: string; args: string }>()
  for (const m of history) {
    if (m.role !== 'assistant') continue
    const calls = m.tool_calls
    if (!Array.isArray(calls)) continue
    for (const tc of calls) {
      out.set(tc.id, {
        name: tc.function.name,
        args: tc.function.arguments ?? '',
      })
    }
  }
  return out
}

/** After a `run_skill_script` succeeds, previous `read_skill_file` results
 *  for the same skill are no longer load-bearing — the LLM has already used
 *  them to build the spec. Replace their content with a placeholder so they
 *  don't balloon the prompt on subsequent turns. */
function elideReadSkillFileResults(history: ChatMessage[], skill: string): number {
  const meta = indexToolCalls(history)
  let bytesSaved = 0
  for (const m of history) {
    if (m.role !== 'tool') continue
    const info = meta.get(m.tool_call_id ?? '')
    if (!info || info.name !== 'read_skill_file') continue
    let argSkill: string | undefined
    try {
      argSkill = (JSON.parse(info.args || '{}') as { skill?: string }).skill
    } catch {
      /* ignore */
    }
    if (skill && argSkill && argSkill !== skill) continue
    if (typeof m.content === 'string' && !m.content.startsWith('<elided')) {
      bytesSaved += m.content.length
      m.content = `<elided: read_skill_file(${argSkill ?? skill}) — skill script has since run successfully>`
    }
  }
  return bytesSaved
}

/** Delegation tool_results can be multi-KB agent prose. The parent node only
 *  needs the gist for its next decision; the full text is already persisted
 *  in run_events. Replace oversize content with a short summary pointer. */
function summarizeLargeDelegationResult(content: string): string {
  const LIMIT = 2000
  if (content.length <= LIMIT) return content
  const head = content.slice(0, 600).trim()
  return `${head}\n\n…[delegation result truncated — original ${content.length} chars, full text preserved in run_events]`
}

// -------- Semaphore (replaces asyncio.Semaphore) --------

export class Semaphore {
  private permits: number
  private waiters: Array<() => void> = []
  private max: number

  constructor(max: number) {
    this.permits = max
    this.max = max
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.permits += 1
  }

  locked(): boolean {
    return this.permits === 0
  }

  inUse(): number {
    return this.max - this.permits
  }

  total(): number {
    return this.max
  }
}

/**
 * Round-limit fallback — centralised so the runNode emission path and the
 * unit test agree on message shape and locale.
 */
export function roundLimitFallback(maxRounds: number, locale: 'ko' | 'en'): string {
  if (locale === 'ko') {
    return `이번 턴에서 도구 호출 한도(${maxRounds}회)에 도달해 작업을 마무리하지 못했습니다. 필요하면 다음 메시지로 "계속"이라고 알려주시거나, 범위를 더 좁혀 다시 요청해 주세요.`
  }
  return `Hit the tool-call budget for this turn (${maxRounds} rounds) before finishing. Send "continue" to resume, or narrow the request and try again.`
}

interface RoundLimitOpts {
  sessionId: string
  nodeId: string
  role: string
  depth: number
  maxRounds: number
  locale: 'ko' | 'en'
}

export function makeRoundLimitEvents(opts: RoundLimitOpts): Event[] {
  const { sessionId, nodeId, role, depth, maxRounds, locale } = opts
  const output = roundLimitFallback(maxRounds, locale)
  return [
    makeEvent(
      'turn.round_limit',
      sessionId,
      { max_rounds: maxRounds, depth, agent_role: role },
      { depth, node_id: nodeId },
    ),
    makeEvent(
      'node_finished',
      sessionId,
      { output },
      { depth, node_id: nodeId },
    ),
  ]
}

/**
 * Idempotent single-permit holder. Guards against double-acquire / double-
 * release bugs when a chat session releases its permit to park on
 * inbox.pop() and re-acquires when a follow-up message arrives.
 *
 * Exported for unit testing — the chat release-on-park wiring inside
 * runTeamBody uses this.
 */
export class SemaphoreHolder {
  private held = false
  constructor(private readonly sem: Semaphore) {}
  async acquire(): Promise<void> {
    if (this.held) return
    await this.sem.acquire()
    this.held = true
  }
  release(): void {
    if (!this.held) return
    this.sem.release()
    this.held = false
  }
  isHeld(): boolean {
    return this.held
  }
}

function getRunSemaphore(): Semaphore {
  const s = state()
  if (!s.semaphore) {
    s.semaphore = new Semaphore(Math.max(1, getSettings().maxConcurrentRuns))
  }
  return s.semaphore
}

export function activeRunCapacity(): { inUse: number; total: number } {
  const sem = getRunSemaphore()
  return { inUse: sem.inUse(), total: sem.total() }
}

// -------- MCP bridge --------

import * as mcpManagerImpl from '../mcp/manager'
import type { getTools as getMcpTools } from '../mcp/manager'
import { compactHistory } from './history-window'
import { getTeamMcpTools } from './mcp-tools-cache'

type ToolInfo = Awaited<ReturnType<typeof getMcpTools>>[number]

/** Thin indirection so tests / alternate deployments can swap in a different
 *  MCP backend without rewiring the engine. Default = real stdio manager. */
function mcpManager() {
  return mcpManagerImpl
}

// -------- top-level run_team generator --------

export interface SessionTeamOpts {
  teamSlugs?: [string, string] | null
  locale?: string
  /** When set, runTeam reuses the given sessionId instead of minting a new
   *  one, seeds the Lead's chat history with `resume.history`, and emits a
   *  `user_message` (for the follow-up) instead of a fresh `run_started`.
   *  `goal` is interpreted as the new user message. Used by
   *  session-registry.resume() to continue a parked session after its
   *  original process died. */
  resume?: {
    sessionId: string
    history: ChatMessage[]
  }
}

/** Per-session queue of follow-up user messages. The chat loop pops from this
 *  after each Lead turn finishes; the HTTP route pushes into it. Kept on
 *  globalThis to survive Next HMR. */
interface ChatInboxState {
  queues: Map<string, PromiseQueue<string>>
}
const globalForInbox = globalThis as unknown as {
  __openhive_chat_inbox?: ChatInboxState
}
function inboxState(): ChatInboxState {
  if (!globalForInbox.__openhive_chat_inbox) {
    globalForInbox.__openhive_chat_inbox = { queues: new Map() }
  }
  return globalForInbox.__openhive_chat_inbox
}
function ensureQueue(sessionId: string): PromiseQueue<string> {
  const s = inboxState()
  let q = s.queues.get(sessionId)
  if (!q) {
    q = new PromiseQueue<string>()
    s.queues.set(sessionId, q)
  }
  return q
}
/** External entry point — the HTTP route calls this when the user sends a
 *  follow-up. Returns false if the session is not live. */
export function pushUserMessage(sessionId: string, text: string): boolean {
  const q = inboxState().queues.get(sessionId)
  if (!q) return false
  q.push(text)
  return true
}

/** Called by the registry when a session is being aborted — wakes any pending
 *  inbox.pop() so the generator can observe the abort and exit cleanly. */
export function closeUserInbox(sessionId: string): void {
  const q = inboxState().queues.get(sessionId)
  if (q) q.close()
}

export async function* runTeam(
  team: TeamSpec,
  goal: string,
  opts: SessionTeamOpts = {},
): AsyncGenerator<Event> {
  const sessionId = opts.resume?.sessionId ?? newSessionId()
  const sem = getRunSemaphore()

  const queued = sem.locked()
  if (queued) {
    const { inUse, total } = activeRunCapacity()
    yield makeEvent('run_queued', sessionId, {
      team_id: team.id,
      goal,
      in_use: inUse,
      limit: total,
    })
  }
  const permit = new SemaphoreHolder(sem)
  await permit.acquire()

  try {
    state().askUser.set(sessionId, 0)
    if (opts.teamSlugs) state().teamSlugs.set(sessionId, opts.teamSlugs)

    // Wrap the entire run in the locale context so error formatter sees it.
    const iter = errors.withRunLocale(opts.locale ?? 'en', () =>
      runTeamBody(team, goal, sessionId, opts.resume?.history, permit),
    )
    // `iter` is the async generator that yields the engine's full event stream
    // (including the A2 SessionStart / PreToolUse / Stop hook events emitted
    // below). runTeamBody hands the `permit` back and forth as it moves
    // between active turns and parked-on-inbox states.
    for await (const ev of iter) yield ev
  } finally {
    state().askUser.delete(sessionId)
    state().teamSlugs.delete(sessionId)
    for (const k of state().delegations.keys()) {
      if (k.startsWith(`${sessionId}:`)) state().delegations.delete(k)
    }
    state().readSkillFileTotal.delete(sessionId)
    state().readSkillFileSeen.delete(sessionId)
    state().webSearch.delete(sessionId)
    state().todos.delete(sessionId)
    // S3 fork: release snapshot history ref so parent history GC can proceed.
    state().lastTurnSnapshot.delete(sessionId)
    const forkPrefix = `${sessionId}:`
    for (const k of state().forkSystemCache.keys()) {
      if (k.startsWith(forkPrefix)) state().forkSystemCache.delete(k)
    }
    errors.clearSessionFailures(sessionId)
    // Belt-and-suspenders: release is idempotent, so even if runTeamBody
    // already released before its final error path, this is a no-op.
    permit.release()
  }
}

async function* runTeamBody(
  team: TeamSpec,
  goal: string,
  sessionId: string,
  resumeHistory?: ChatMessage[],
  permit?: SemaphoreHolder,
): AsyncGenerator<Event> {
  const isResume = !!resumeHistory
  const startedAt = Date.now()
  let injectedSystemSuffix: string | undefined
  if (isResume) {
    // Session already exists on disk. `goal` is the new user message — emit
    // it as user_message so the stream looks identical to a live follow-up.
    yield makeEvent('user_message', sessionId, { text: goal })
  } else {
    // [A2 HOOK] SessionStart — fire only on fresh sessions, before any event
    // hits events.jsonl, so `additionalContext` can be folded into the first
    // system prompt. Failures are non-fatal and logged only.
    try {
      const companyId = companyIdFromSession(sessionId)
      const outcome = await runHooks(
        'SessionStart',
        companyId ?? '',
        {
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          transcript_path: sessionsStore.sessionTranscriptPath(sessionId),
          cwd: process.cwd(),
          company_id: companyId,
          team_id: team.id,
          data_dir: dataDir(),
          goal,
          team_snapshot: team,
          source: 'fresh',
        },
        { sessionId },
      )
      for (const e of outcome.events) yield e
      injectedSystemSuffix = outcome.additionalContext ?? undefined
    } catch (exc) {
      console.warn(
        `[hooks] SessionStart failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      )
    }
    yield makeEvent('run_started', sessionId, { team_id: team.id, goal })
  }
  const entry = entryAgent(team)
  // The Lead's history persists across turns — this is what makes the session
  // a chat rather than a one-shot run. On resume we seed it from the prior
  // events.jsonl; otherwise it starts empty and grows as each turn runs.
  const leadHistory: ChatMessage[] = resumeHistory ? [...resumeHistory] : []
  const inbox = ensureQueue(sessionId)
  let currentTask = goal
  let lastFinal = ''
  let stopStatus: 'completed' | 'error' | 'idle' = 'idle'
  let stopError: string | null = null
  try {
    while (true) {
      for await (const ev of runNode({
        sessionId,
        team,
        node: entry,
        task: currentTask,
        depth: 0,
        externalHistory: leadHistory,
        injectedSystemSuffix,
      })) {
        if (ev.kind === 'node_finished' && ev.depth === 0) {
          lastFinal = (ev.data.output as string | undefined) ?? ''
        }
        yield ev
      }
      // The injected SessionStart suffix only applies to the first Lead turn —
      // subsequent turns in this session see the vanilla system prompt.
      injectedSystemSuffix = undefined
      // Lead finished a turn — park until the user sends another message.
      yield makeEvent('turn_finished', sessionId, { output: lastFinal })
      // Release the concurrency permit while parked so other sessions can
      // start. Idle chat tabs used to hold their slot indefinitely, so after
      // `maxConcurrentRuns` unfinished chats the next one queued forever.
      // The holder is idempotent — reacquire on the follow-up message, and
      // the outer try/finally still releases on teardown.
      permit?.release()
      const next = await inbox.pop()
      // null = session being torn down.
      if (next === null) break
      await permit?.acquire()
      // Per-turn reset of engine caps. The C-series caps (delegation /
      // ask_user / read_skill_file) guard against in-turn loops — e.g. a
      // Lead re-delegating a "REVISED TASK" to the same sub three times in
      // one burst. A chat session, though, is one engine "run" that spans
      // many user turns, so sessionwide accounting turns legitimate follow-
      // ups ("I've answered your clarifying question, now try again") into
      // hard dead-ends. The user message is the natural boundary: once they
      // respond, the context is new and the parent deserves a fresh budget.
      // Only wipes this session's keys — other live sessions keep their
      // in-flight counters.
      resetPerTurnCaps(sessionId)
      yield makeEvent('user_message', sessionId, { text: next })
      currentTask = next
    }
    yield makeEvent('run_finished', sessionId, { output: lastFinal })
    stopStatus = 'completed'
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc)
    yield makeEvent('run_error', sessionId, { error: message })
    stopStatus = 'error'
    stopError = message
  } finally {
    // [A2] Finalize + Stop hook: call finalizeSession directly here so the
    // Stop hook sees transcript/usage/meta on disk. The registry also calls
    // finalizeSession after us — the idempotent guard in sessions.ts makes
    // that a cheap no-op. If any step throws, we still clear the inbox queue.
    try {
      await sessionsStore.finalizeSession(sessionId, {
        output: stopStatus === 'completed' ? lastFinal : null,
        error: stopError,
      })
      try {
        const companyId = companyIdFromSession(sessionId)
        const lastSeq = lastEventSeq(sessionId)
        const artifactPaths = listArtifactPaths(sessionId)
        const outcome = await runHooks(
          'Stop',
          companyId ?? '',
          {
            hook_event_name: 'Stop',
            session_id: sessionId,
            transcript_path: sessionsStore.sessionTranscriptPath(sessionId),
            cwd: process.cwd(),
            company_id: companyId,
            team_id: team.id,
            data_dir: dataDir(),
            status: stopStatus,
            duration_ms: Date.now() - startedAt,
            artifact_paths: artifactPaths,
            last_event_seq: lastSeq,
            output: stopStatus === 'completed' ? lastFinal : null,
            error: stopError,
          },
          { sessionId },
        )
        for (const e of outcome.events) yield e
      } catch (exc) {
        console.warn(`[hooks] Stop failed: ${exc instanceof Error ? exc.message : String(exc)}`)
      }
    } finally {
      inboxState().queues.delete(sessionId)
    }
  }
}

/** Pulls the company slug registered for this session (if any). Returns `null`
 *  for ad-hoc / teamSlug-less runs. */
function companyIdFromSession(sessionId: string): string | null {
  const slugs = state().teamSlugs.get(sessionId)
  return slugs ? slugs[0] : null
}

/** Returns the highest `seq` currently visible in events.jsonl, or 0 when
 *  the file is empty / missing. Used for Stop-hook payload metadata. */
function lastEventSeq(sessionId: string): number {
  try {
    const rows = sessionsStore.eventsForSession(sessionId)
    if (rows.length === 0) return 0
    const last = rows[rows.length - 1]
    return last ? last.seq : 0
  } catch {
    return 0
  }
}

/** Returns absolute paths of files under the session's `artifacts/` dir. */
function listArtifactPaths(sessionId: string): string[] {
  try {
    const dir = sessionsStore.sessionArtifactDir(sessionId)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).map((name) => `${dir}/${name}`)
  } catch {
    return []
  }
}

/** Minimal cancellable queue — pop() resolves on push or on close() (with null). */
class PromiseQueue<T> {
  private buffer: T[] = []
  private waiters: Array<(v: T | null) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w(value)
    else this.buffer.push(value)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w(null)
  }

  async pop(): Promise<T | null> {
    if (this.buffer.length > 0) return this.buffer.shift()!
    if (this.closed) return null
    return new Promise<T | null>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

// -------- per-node driver --------

interface SessionNodeOpts {
  sessionId: string
  team: TeamSpec
  node: AgentSpec
  task: string
  depth: number
  /** If provided, the caller owns history across turns (chat mode). runNode
   *  appends to this array instead of building its own. */
  externalHistory?: ChatMessage[]
  /** Text returned by an A2 `SessionStart` hook as `additionalContext`.
   *  Concatenated to the built system prompt only for the Lead (depth 0) on
   *  the first turn of the session. Undefined = no injection. */
  injectedSystemSuffix?: string
  /** File-write visibility this node operates under. Derived from the
   *  parent's `delegate_to(mode: ...)`:
   *    - `'user'`     — this node may produce user-facing artifacts (the
   *                     Lead's default; also the mode for a single
   *                     designated producer sub-agent such as a
   *                     report-specialist).
   *    - `'scratch'`  — this node is doing research / verification; its
   *                     skill tool file outputs land in `scratch/{nodeId}/`
   *                     and never appear in the session artifact index.
   *  Undefined = 'user' (lead / back-compat). */
  visibility?: 'user' | 'scratch'
}

async function* runNode(opts: SessionNodeOpts): AsyncGenerator<Event> {
  const { sessionId, team, node, task, depth, externalHistory, injectedSystemSuffix } = opts
  const teamSlugs = state().teamSlugs.get(sessionId) ?? null
  // Lead (depth 0) is always 'user' — it owns the session's artifact
  // namespace. Sub-agents inherit visibility from their parent's
  // `delegate_to(mode)`; absent opts.visibility keeps legacy behaviour
  // (treats the node as a producer, same as before this change).
  const visibility: 'user' | 'scratch' =
    depth === 0 ? 'user' : (opts.visibility ?? 'user')

  yield makeEvent('node_started', sessionId, { role: node.role, task }, { depth, node_id: node.id })

  const maxDepth = Math.min(team.limits.max_delegation_depth, HARD_MAX_DEPTH)
  const maxRounds = Math.min(team.limits.max_tool_rounds_per_turn, HARD_MAX_TOOL_ROUNDS)

  const persona = resolvePersona(node, team)

  const subs = teamSubordinates(team, node.id)
  const tools: Tool[] = []
  if (subs.length > 0 && depth < maxDepth) {
    tools.push(delegateTool(team, node))
    if (subs.some((s) => s.max_parallel > 1)) {
      tools.push(delegateParallelTool(team, node))
    }
  }
  if (depth === 0) {
    tools.push(askUserTool())
    tools.push(...todoTools(sessionId))
    // S4: Lead-only work-ledger recall. Requires a resolved company slug.
    if (teamSlugs && !isLedgerDisabled()) {
      tools.push(...ledgerTools(teamSlugs[0]))
    }
  }
  if (teamSlugs) {
    tools.push(...teamDataTools(teamSlugs[0], team.id, persona.tools))
  }
  // A3: artifact rehydration — Lead + sub-agent both need to re-read files
  // produced earlier in the session (microcompact may have cleared the
  // envelope bodies that first carried them).
  tools.push(readArtifactTool(sessionId))

  // Skills: typed get a structured tool; agent-format go through activate/read/run.
  //
  // Resolution:
  //   1. Start with what the agent declared (node.skills ∪ persona.tools.skills).
  //   2. If the agent declared NOTHING, fall back to every bundled + user skill
  //      so legacy teams (created before DEFAULT_AGENT_SKILLS was introduced —
  //      see 61cae18) still expose pdf/docx/etc. metadata to the LLM. Without
  //      this, an agent with `skills: []` got zero skill tools registered and
  //      the LLM had no way to produce files even when they were physically
  //      available on disk.
  //   3. team.allowed_skills, if non-empty, narrows whatever we resolved above.
  //      Empty team.allowed_skills is treated as "no narrowing", matching the
  //      mental model that whitelist = opt-in restriction.
  const declared = effectiveSkills(node, persona)
  const candidates =
    declared.length > 0 ? declared : Array.from(listSkills().keys())
  const rawAllowed = team.allowed_skills ?? []
  const hasAllowlist = rawAllowed.length > 0
  const allowed = new Set(rawAllowed)
  const typedSkills: SkillDef[] = []
  const agentSkills: SkillDef[] = []
  for (const name of candidates) {
    if (hasAllowlist && !allowed.has(name)) continue
    const skill = getSkill(name)
    if (!skill) continue
    if (skill.kind === 'typed') typedSkills.push(skill)
    else agentSkills.push(skill)
  }
  const skillCtx: SkillToolContext = {
    sessionId,
    team,
    teamSlugs,
    nodeId: node.id,
    visibility,
  }
  for (const skill of typedSkills) {
    tools.push(skillTool(skill, skillCtx))
  }
  if (agentSkills.length > 0) {
    tools.push(skillActivateTool(agentSkills))
    tools.push(skillListFilesTool(agentSkills))
    tools.push(skillReadTool(agentSkills, sessionId, team))
    tools.push(skillRunTool(agentSkills, skillCtx))
  }

  // MCP: per-server get_tools, wrap each as <server>__<tool>. A misconfigured
  // server surfaces a tool_result error but doesn't kill the run. The
  // (teamId, sorted servers) cache means sibling/descendant nodes in the
  // same session reuse the already-resolved tool list instead of re-wrapping.
  const effectiveMcp = effectiveMcpServers(team.allowed_mcp_servers ?? [], persona)
  const teamMcp = await getTeamMcpTools(team.id, effectiveMcp, (s) => mcpManager().getTools(s))
  for (const { serverName, tools: mcpTools, error } of teamMcp) {
    if (error) {
      yield makeEvent(
        'tool_result',
        sessionId,
        { content: `MCP server '${serverName}' unavailable: ${error}`, is_error: true },
        { depth, node_id: node.id, tool_name: `${serverName}__init` },
      )
      continue
    }
    for (const t of mcpTools)
      tools.push(mcpTool(serverName, t as unknown as Record<string, unknown>))
  }

  // Progressive disclosure: system prompt only holds skill NAMES + one-line
  // descriptions. Bodies + file trees arrive via activate_skill once the LLM
  // picks one.
  const personaBody = composePersonaBody(persona)
  const teamSection = describeTeamForAgent(team, node.id)
  const hasSubs = subs.length > 0
  const relaySection = buildRelaySection(depth, hasSubs, team)
  const staticTeamBlock = teamSection + (relaySection ? '\n' + relaySection : '')
  // Skill auto-hint: match the incoming task once against frontmatter triggers
  // so the first turn's system prompt nudges the LLM toward relevant skills.
  // We only inject hints on turn 1 — after that, the LLM has already chosen.
  const hintedSkills = matchSkillHints(task, agentSkills)
  const hintsBlock = renderSkillHints(hintedSkills)
  const buildSystemPrompt = (turn: number): string => {
    const todos = depth === 0 ? (state().todos.get(sessionId) ?? []) : []
    const todosBlock = renderTodosSection(todos)
    const showHints = turn === 1 && hintsBlock.length > 0
    // Session-wide artifact manifest: Lead sees every file produced so far,
    // so the final answer can cite them as artifact:// links without relying
    // on whatever the last tool_result happened to contain.
    const artifactRecords =
      depth === 0 ? artifactsStore.listForSession(sessionId) : []
    const manifestBlock = renderSessionArtifacts(
      artifactRecords.map((r) => toManifestEntry(r, sessionId)),
    )
    // Engine-injected deliverables policy — Lead only. Earlier symptom (PDF +
    // CSV + summary.txt sidecars, sessions df76dd49 / 3e0c65e1) proved that
    // prompt-only enforcement is not enough — research/verify workers were
    // obligingly writing JSON+CSV+TXT because their briefings demanded it.
    // Fixed structurally: research/verify delegations now route file writes
    // to private scratch (invisible to user). This block reminds the Lead of
    // the phase workflow at the point of use; the backing mechanism lives in
    // delegate_to's mode parameter. Gating on depth === 0 keeps this out of
    // sub-agent prompts — subs get their policy via the task brief.
    const deliverablesPolicy =
      depth === 0
        ? `# Phase reminder\nResearch/verify sub-agents CAN'T create user-visible files — those delegations' files go to private scratch. Only a \`mode: produce\` delegation (or your own skill call) makes a user artifact. Before you dispatch \`mode: produce\`, synthesize findings into a concrete spec (content, structure, filename). One produce delegation = one file.\n`
        : ''
    const prefix =
      (manifestBlock ? manifestBlock + '\n' : '') +
      (todosBlock ? todosBlock + '\n' : '') +
      (showHints ? hintsBlock + '\n' : '') +
      (deliverablesPolicy ? deliverablesPolicy + '\n' : '')
    const teamBlock = prefix ? prefix + staticTeamBlock : staticTeamBlock
    return composeSystemPrompt(personaBody, agentSkills, teamBlock)
  }
  tools.push(...makePersonaTools(persona))

  const history: ChatMessage[] = externalHistory ?? []
  history.push({ role: 'user', content: task, _ts: Date.now() })

  // History sliding-window: Infinity keeps the feature inert by default so
  // existing sessions see byte-identical prompts. Nodes can opt in later by
  // surfacing a finite window via persona config.
  const historyWindow = Number.POSITIVE_INFINITY
  const summariseHistory = async (_msgs: ChatMessage[]): Promise<string> => ''

  let rounds = 0
  while (true) {
    rounds += 1
    if (rounds > maxRounds) {
      // Round budget exhausted. Without a final node_finished here, runTeamBody
      // would set lastFinal="" and emit turn_finished with an empty output —
      // the UI showed nothing, so the user thought the session had silently
      // died. Instead we emit a telemetry event and a localized fallback
      // message so the chat actually reads "I hit my tool-round limit before
      // finishing — here's where I got to", and downstream code (task title,
      // resume) has real text to work with.
      for (const ev of makeRoundLimitEvents({
        sessionId,
        nodeId: node.id,
        role: node.role,
        depth,
        maxRounds,
        locale: errors.currentLocale(),
      })) {
        yield ev
      }
      return
    }

    // Only pays when the node has opted into a finite window.
    if (Number.isFinite(historyWindow)) {
      const next = await compactHistory(history, historyWindow, summariseHistory)
      if (next !== history) {
        history.length = 0
        history.push(...next)
      }
    }

    let turnDone = false
    // A2: splice SessionStart-hook `additionalContext` onto the system prompt
    // only for the Lead's first turn. Downstream sub-agent nodes and later
    // turns in the same session see the vanilla prompt.
    const baseSystem = buildSystemPrompt(rounds)
    const systemPromptForTurn =
      depth === 0 && rounds === 1 && injectedSystemSuffix
        ? `${baseSystem}\n\n---\n\n[Injected by SessionStart hook]\n${injectedSystemSuffix}`
        : baseSystem
    // Round-level observability: lets us diagnose "session silently stopped"
    // bugs (empty round-2 output, protocol regressions) straight from the
    // event log without having to reconstruct from node_finished shapes.
    yield makeEvent(
      'round_started',
      sessionId,
      { round: rounds },
      { depth, node_id: node.id },
    )
    for await (const ev of streamTurn({
      sessionId,
      team,
      node,
      systemPrompt: systemPromptForTurn,
      history,
      tools,
      depth,
    })) {
      if (ev.kind === 'node_finished' && ev.data._turn_marker === true) {
        const stopReason = ev.data.stop_reason as string | undefined
        const output = typeof ev.data.output === 'string' ? ev.data.output : ''
        yield makeEvent(
          'round_finished',
          sessionId,
          {
            round: rounds,
            stop_reason: stopReason ?? 'stop',
            text_len: output.length,
            had_tool_calls: stopReason === 'tool_calls',
          },
          { depth, node_id: node.id },
        )
        if (stopReason === 'tool_calls') {
          turnDone = true
          break
        }
        // Empty-round defence: on any round AFTER round 1, if the provider
        // returned both zero text and no tool calls, the turn would finalise
        // with output="" — the exact silent-death failure mode we hit before
        // attach_item_ids was wired up. Log telemetry and synthesize a
        // minimal fallback so the user sees something useful instead of a
        // dead session. Round 1 emptiness is a legitimate "nothing to say"
        // case (rare, e.g. greeting turn) and is passed through unchanged.
        if (rounds > 1 && stopReason !== 'tool_calls' && output.trim() === '') {
          yield makeEvent(
            'provider.empty_round',
            sessionId,
            {
              provider: node.provider_id,
              model: node.model,
              round: rounds,
            },
            { depth, node_id: node.id },
          )
          const fallback = buildEmptyRoundFallback(history, errors.currentLocale())
          yield makeEvent(
            'node_finished',
            sessionId,
            { output: fallback },
            { depth, node_id: node.id },
          )
          return
        }
        yield makeEvent(
          'node_finished',
          sessionId,
          { output: ev.data.output ?? '' },
          { depth, node_id: node.id },
        )
        return
      }
      yield ev
    }
    if (!turnDone) break
  }
}

/** Last-ditch assistant reply when the provider returns an empty round
 *  after tool execution. Concatenates whatever the most recent tool
 *  results contained into a short summary so the user at least sees the
 *  work product instead of a blank bubble. Locale-aware prefix. */
function buildEmptyRoundFallback(
  history: ChatMessage[],
  locale: 'ko' | 'en',
): string {
  const toolOutputs: string[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role !== 'tool') break
    const c = typeof m.content === 'string' ? m.content : ''
    if (c) toolOutputs.unshift(c)
  }
  const prefix =
    locale === 'ko'
      ? '정리 도중 응답이 비어 중단됐습니다. 아래는 지금까지 수집된 원본 결과입니다 — 다시 시도해 주세요.'
      : 'The model returned an empty follow-up response. Here is the raw tool output gathered so far — please retry.'
  if (toolOutputs.length === 0) return prefix
  const joined = toolOutputs.join('\n\n---\n\n')
  const capped = joined.length > 4000 ? `${joined.slice(0, 4000)}\n\n…(truncated)` : joined
  return `${prefix}\n\n${capped}`
}

// -------- provider turn --------

interface StreamTurnOpts {
  sessionId: string
  team: TeamSpec
  node: AgentSpec
  systemPrompt: string
  history: ChatMessage[]
  tools: Tool[]
  depth: number
  /** S3 fork: when provided, bypass `toolsToOpenAI(tools)` and use these
   *  already-serialized specs verbatim. Required for sibling byte-identity. */
  toolsOverride?: ToolSpec[]
  /** S3 fork: when provided, forwarded to the claude provider as
   *  `overrideSystem` so `splitSystem` is bypassed and the parent's
   *  verbatim system string is used. */
  systemPromptOverride?: string
  /** S3 fork: sentinel telling the caching strategy not to reorder tools. */
  useExactTools?: boolean
  /** S3 fork: when true, the assistant+tool_calls arising from this stream
   *  must NOT be pushed into `history` — the parent's history is shared by
   *  reference with sibling children, and mutations would break prefix
   *  identity. Fork children signal their output via `node_finished` only. */
  noHistoryPush?: boolean
}

async function* streamTurn(opts: StreamTurnOpts): AsyncGenerator<Event> {
  const { sessionId, team, node, systemPrompt, history, tools, depth } = opts
  // Time-based microcompact: clear stale read-only tool_result bodies before
  // the prompt is built. Only applies to Lead (depth === 0); sub-agent
  // histories are short and ephemeral so ROI is zero. No-op when the last
  // assistant turn is still within STALE_AFTER_MS (cache hot).
  if (depth === 0) {
    const mc = maybeMicrocompact(history, sessionId)
    for (const e of mc.entries) {
      yield makeEvent(
        'microcompact.applied',
        sessionId,
        {
          tool_name: e.tool_name,
          tool_call_id: e.tool_call_id,
          original_chars: e.original_chars,
        },
        {
          depth,
          node_id: node.id,
          tool_call_id: e.tool_call_id,
          tool_name: e.tool_name,
        },
      )
    }
  }
  const messages = buildMessages(systemPrompt, history)
  const openaiTools = opts.toolsOverride ?? (tools.length > 0 ? toolsToOpenAI(tools) : undefined)

  // S3 fork snapshot: parallel children about to be dispatched within this
  // turn will read this to assemble byte-identical prefix messages. The
  // `history` ref is stashed as-is (no copy) — parent mutations happen after
  // this turn's assistant message lands, and children slice up to that index.
  state().lastTurnSnapshot.set(sessionId, {
    systemPrompt,
    history,
    tools: openaiTools ?? [],
    providerId: node.provider_id,
    model: node.model,
    nodeId: node.id,
    depth,
    builtAt: Date.now(),
  })

  // Phase G1: attribute payload size to system vs tools vs history so we can
  // later rank which region is driving spend. Char counts, not tokens — a
  // cheap proxy that doesn't need a tokenizer.
  const systemChars = systemPrompt.length
  const toolsChars = openaiTools ? JSON.stringify(openaiTools).length : 0
  let historyChars = 0
  for (const m of history) {
    if (typeof m.content === 'string') historyChars += m.content.length
    else if (Array.isArray(m.content)) historyChars += JSON.stringify(m.content).length
    if (Array.isArray(m.tool_calls)) historyChars += JSON.stringify(m.tool_calls).length
  }

  // A4: token estimates alongside char counts. char fields stay (drift
  // baseline + existing usage views). `ew` carries all thresholds; we decide
  // which one the current estimate crossed for this turn.
  const systemTokens = estimateTextTokens(systemPrompt)
  const toolsTokens = estimateToolsTokens(openaiTools)
  const historyTokens = estimateMessagesTokens(history)
  const estimatedInputTokens = systemTokens + toolsTokens + historyTokens
  const ew = computeEffectiveWindow(node.provider_id, node.model)
  let thresholdTriggered: ThresholdTrigger = 'none'
  if (estimatedInputTokens > ew.blockingLimit) thresholdTriggered = 'blocking'
  else if (estimatedInputTokens > ew.autoCompactThreshold) thresholdTriggered = 'autocompact'
  else if (estimatedInputTokens > ew.warningThreshold) thresholdTriggered = 'warning'

  // A4 Phase 3 — env-gated block. Default off (logging only). When enabled,
  // refuse to start the turn so runDelegation / runTeam catch + either
  // summarise back to parent or mark the session interrupted.
  if (shouldBlockTurn(estimatedInputTokens, node.provider_id, node.model)) {
    yield makeEvent(
      'turn.blocked',
      sessionId,
      {
        reason: 'context_overflow',
        estimated_tokens: estimatedInputTokens,
        blocking_limit: ew.blockingLimit,
        provider_id: node.provider_id,
        model: node.model,
      },
      { depth, node_id: node.id },
    )
    if (process.env.OPENHIVE_BLOCK_ON_OVERFLOW === '1') {
      throw new errors.ContextOverflowError({
        estimatedTokens: estimatedInputTokens,
        blockingLimit: ew.blockingLimit,
        providerId: node.provider_id,
        model: node.model,
      })
    }
  }

  const textBuf: string[] = []
  interface Pending {
    id: string | null
    name: string | null
    args: string
  }
  const pending = new Map<number, Pending>()
  let stopReason = 'stop'

  // Depth-0 Lead gets a lower temperature — small models (gpt-5-mini) at 0.7
  // invent section structure on simple turns. 0.3 keeps them focused on the
  // answer without zeroing out creativity. Sub-agents keep the default 0.7.
  const leadTemperature = depth === 0 ? 0.3 : undefined
  // Always pass sessionId through so the Codex adapter can key its
  // `previous_response_id` chaining Map per-session (concurrent sessions
  // otherwise stomp on each other's chain head via the globalThis slot).
  const streamOpts = {
    useExactTools: opts.useExactTools,
    overrideSystem: opts.systemPromptOverride,
    temperature: leadTemperature,
    sessionId,
  }
  // Meta-label stripper buffer — only applied to Lead (depth 0) turns where
  // small-model slop is the concern. Sub-agent output goes through un-stripped
  // (their text is for parent synthesis, not UI display).
  let stripBuf = ''
  const emitStripped = (raw: string): string[] => {
    // Returns the chunks to emit as token events. Accumulates raw text until
    // a paragraph boundary (\n\n), at which point stable paragraphs are
    // passed through stripMetaLabels and emitted. Remaining tail stays in
    // stripBuf for the next call.
    if (depth !== 0) return [raw]
    stripBuf += raw
    const lastBreak = stripBuf.lastIndexOf('\n\n')
    if (lastBreak < 0) return []
    const stable = stripBuf.slice(0, lastBreak + 2)
    stripBuf = stripBuf.slice(lastBreak + 2)
    const cleaned = stripMetaLabels(stable)
    return cleaned ? [cleaned + (cleaned.endsWith('\n') ? '' : '\n\n')] : []
  }
  const flushStripped = (): string[] => {
    if (depth !== 0 || stripBuf.length === 0) return []
    const cleaned = stripMetaLabels(stripBuf)
    stripBuf = ''
    return cleaned ? [cleaned] : []
  }

  for await (const delta of stream(node.provider_id, node.model, messages, openaiTools, streamOpts)) {
    if (delta.kind === 'text') {
      textBuf.push(delta.text)
      for (const chunk of emitStripped(delta.text)) {
        yield makeEvent('token', sessionId, { text: chunk }, { depth, node_id: node.id })
      }
    } else if (delta.kind === 'tool_call') {
      let p = pending.get(delta.index)
      if (!p) {
        p = { id: null, name: null, args: '' }
        pending.set(delta.index, p)
      }
      if (delta.id) p.id = delta.id
      if (delta.name) p.name = delta.name
      if (delta.arguments_chunk) p.args += delta.arguments_chunk
    } else if (delta.kind === 'usage') {
      // Logging shouldn't kill the run — catch-all.
      const actualInput = delta.input_tokens ?? 0
      try {
        const slugs = state().teamSlugs.get(sessionId) ?? null
        recordUsage({
          sessionId,
          companyId: slugs ? slugs[0] : null,
          teamId: team.id,
          agentId: node.id,
          agentRole: node.role,
          providerId: node.provider_id,
          model: node.model,
          inputTokens: actualInput,
          outputTokens: delta.output_tokens ?? 0,
          cacheReadTokens: delta.cache_read_tokens ?? 0,
          cacheWriteTokens: delta.cache_write_tokens ?? 0,
          systemChars,
          toolsChars,
          historyChars,
          estimatedInputTokens,
          actualInputTokens: actualInput,
          effectiveWindow: ew.window,
          autoCompactThreshold: ew.autoCompactThreshold,
          warningThreshold: ew.warningThreshold,
          blockingLimit: ew.blockingLimit,
          thresholdTriggered,
        })
      } catch {
        /* swallow */
      }
      // A4 drift event — estimate vs authoritative. >25% diff → emit.
      if (actualInput > 0 && estimatedInputTokens > 0) {
        const driftRatio = Math.abs(actualInput - estimatedInputTokens) / actualInput
        if (driftRatio > 0.25) {
          const padRaw = process.env.OPENHIVE_TOKEN_PAD_FACTOR
          const padFactor = padRaw && Number.isFinite(Number(padRaw)) ? Number(padRaw) : 4 / 3
          yield makeEvent(
            'token.estimate.drift',
            sessionId,
            {
              provider_id: node.provider_id,
              model: node.model,
              estimated: estimatedInputTokens,
              actual: actualInput,
              drift_ratio: Number(driftRatio.toFixed(3)),
              pad_factor: Number(padFactor.toFixed(4)),
            },
            { depth, node_id: node.id },
          )
        }
      }
    } else if (delta.kind === 'stop') {
      stopReason = delta.reason ?? 'stop'
      break
    }
  }
  // Flush any tail buffered by the meta-label stripper (last paragraph with
  // no trailing blank line).
  for (const chunk of flushStripped()) {
    yield makeEvent('token', sessionId, { text: chunk }, { depth, node_id: node.id })
  }

  // For Lead turns the assembled history/content should match what the user
  // saw — strip meta labels here too so downstream (history, transcript,
  // microcompact, S1) never re-encounter them. Also strip any artifact://
  // URIs that don't correspond to a real session artifact (hallucination
  // safety net — sub-agents without file-producing skills sometimes invent
  // plausible URIs).
  const assembledText = (() => {
    if (depth !== 0) return textBuf.join('').trim()
    const realUris = getRealArtifactUriSet(sessionId)
    const cleaned = stripFakeArtifactLinks(
      stripMetaLabels(textBuf.join('')),
      realUris,
    )
    return cleaned.trim()
  })()

  if (pending.size > 0) {
    const ordered = [...pending.entries()].sort(([a], [b]) => a - b)
    const toolCallsForHistory = ordered.map(([, p]) => ({
      id: p.id ?? newId('call'),
      type: 'function' as const,
      function: {
        name: p.name ?? 'unknown',
        arguments: p.args || '{}',
      },
    }))
    history.push({
      role: 'assistant',
      content: assembledText || null,
      tool_calls: toolCallsForHistory,
      _ts: Date.now(),
    })

    // Split tool_calls into serial-vs-parallel runs. Control-flow
    // mutation (ask_user, todo, activate_skill, delegate_parallel) stays
    // serial; writes (sql_exec, run_skill_script) are serialized to avoid
    // intra-turn races; reads (MCP, sql_query, web_fetch, …) fan out
    // under `toolParallelMax`; adjacent `delegate_to` to DIFFERENT subs
    // fan out under the smaller `parallelDelegationMax` (each fires an
    // LLM stream, so the budget cap is lower). History is always pushed
    // in original tool_call order so provider payloads stay deterministic.
    type ExecResult = { content: string; isError: boolean }
    type TC = (typeof toolCallsForHistory)[number]
    const safeParallelCap = toolParallelMax()
    const parallelTrajCap = parallelDelegationMax()
    const v2 = toolPartitionV2Enabled()
    let runs: ToolRun<TC>[]
    if (v2) {
      const partitioned = partitionRuns<TC>(toolCallsForHistory, {
        safe_parallel: safeParallelCap,
        parallel_trajectory: parallelTrajCap,
      })
      runs = partitioned.runs
      if (toolCallsForHistory.length > 0) {
        yield makeEvent(
          'tool_run.partitioned',
          sessionId,
          partitioned.stats as unknown as Record<string, unknown>,
          { depth, node_id: node.id },
        )
      }
    } else {
      // Legacy v1 shape → adapter into the v2 ToolRun shape so the loop
      // below stays single-path.
      const legacy = splitToolRuns<TC>(toolCallsForHistory)
      runs = legacy.map((r) => ({
        kind: r.serial ? ('serial' as const) : ('parallel' as const),
        cls: r.serial ? ('trajectory' as const) : ('safe_parallel' as const),
        items: r.items,
      }))
    }

    const executeOne = async function* (tc: TC): AsyncGenerator<Event, ExecResult> {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = tc.function.arguments
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : {}
      } catch {
        parsedArgs = {}
      }
      yield makeEvent(
        'tool_called',
        sessionId,
        { arguments: parsedArgs },
        { depth, node_id: node.id, tool_call_id: tc.id, tool_name: tc.function.name },
      )

      // [A2 HOOK] PreToolUse — runs after the tool_called event is visible in
      // the stream, before dispatch to the actual handler. An `exit 2` / JSON
      // `decision: 'block'` rewrites the tool result into a synthetic "blocked
      // by hook" message; the next LLM turn sees that via normal history and
      // picks a different path.
      try {
        const companyId = companyIdFromSession(sessionId)
        const hookOutcome = await runHooks(
          'PreToolUse',
          tc.function.name,
          {
            hook_event_name: 'PreToolUse',
            session_id: sessionId,
            transcript_path: sessionsStore.sessionTranscriptPath(sessionId),
            cwd: process.cwd(),
            company_id: companyId,
            team_id: team.id,
            data_dir: dataDir(),
            tool_name: tc.function.name,
            tool_input: parsedArgs,
            agent_id: node.id,
            depth,
            tool_call_id: tc.id,
          },
          { sessionId },
        )
        for (const e of hookOutcome.events) yield e
        if (hookOutcome.decision === 'block') {
          const reason = hookOutcome.reason ?? 'unspecified'
          const sysMsg = hookOutcome.systemMessage ? ` ${hookOutcome.systemMessage}` : ''
          const blockMsg = `[Tool ${tc.function.name} blocked by hook. Reason: ${reason}.${sysMsg}]`
          yield makeEvent(
            'tool_result',
            sessionId,
            { content: blockMsg, is_error: true },
            { depth, node_id: node.id, tool_call_id: tc.id, tool_name: tc.function.name },
          )
          return { content: blockMsg, isError: true }
        }
      } catch (exc) {
        console.warn(
          `[hooks] PreToolUse failed: ${exc instanceof Error ? exc.message : String(exc)}`,
        )
      }

      const tool = tools.find((t) => t.name === tc.function.name)
      let content = ''
      let isError = false

      if (!tool) {
        content = `ERROR: unknown tool '${tc.function.name}'`
        isError = true
      } else {
        try {
          if (tc.function.name === 'delegate_to') {
            for await (const subEv of runDelegation({
              sessionId,
              team,
              fromNode: node,
              args: parsedArgs,
              toolCallId: tc.id,
              depth,
            })) {
              if (subEv.kind === 'delegation_closed') {
                const body = (subEv.data.result as string | undefined) ?? ''
                const paths = subEv.data.artifact_paths as string[] | undefined
                content = appendArtifactBlock(body, paths, sessionId)
                isError = !!subEv.data.error
              }
              yield subEv
            }
          } else if (tc.function.name === 'delegate_parallel') {
            for await (const subEv of runParallelDelegation({
              sessionId,
              team,
              fromNode: node,
              args: parsedArgs,
              toolCallId: tc.id,
              depth,
            })) {
              if (subEv.kind === 'delegation_closed' && subEv.data.group_final) {
                const body = (subEv.data.result as string | undefined) ?? ''
                const paths = subEv.data.artifact_paths as string[] | undefined
                content = appendArtifactBlock(body, paths, sessionId)
                isError = !!subEv.data.error
              }
              yield subEv
            }
          } else if (tc.function.name === 'ask_user') {
            for await (const subEv of runAskUser({
              sessionId,
              team,
              node,
              args: parsedArgs,
              toolCallId: tc.id,
              depth,
            })) {
              if (subEv.kind === 'user_answered') {
                content = (subEv.data.result as string | undefined) ?? ''
                isError = !!subEv.data.error
              }
              yield subEv
            }
          } else if (tool.skill) {
            // Skill tools go through the global Python concurrency limiter;
            // emit queued/started events so the UI can show queue state.
            for await (const subEv of runSkillInvocation({
              sessionId,
              tool,
              args: parsedArgs,
              toolCallId: tc.id,
              toolName: tc.function.name,
              nodeId: node.id,
              depth,
            })) {
              if (subEv.kind === 'tool_result') {
                content = (subEv.data.content as string | undefined) ?? ''
                isError = !!subEv.data.is_error
                // Don't yield tool_result here — the outer yield below
                // emits the canonical tool_result.
                continue
              }
              yield subEv
            }
          } else {
            const raw = await tool.handler(parsedArgs)
            content = typeof raw === 'string' ? raw : JSON.stringify(raw)
            isError = false
          }
        } catch (exc) {
          content = `ERROR: ${exc instanceof Error ? exc.message : String(exc)}`
          isError = true
        }
      }

      yield makeEvent(
        'tool_result',
        sessionId,
        { content, is_error: isError },
        { depth, node_id: node.id, tool_call_id: tc.id, tool_name: tc.function.name },
      )
      if (!isError && TODO_TOOL_NAMES.has(tc.function.name)) {
        yield makeEvent(
          'todos_changed',
          sessionId,
          { todos: state().todos.get(sessionId) ?? [] },
          { depth, node_id: node.id, tool_call_id: tc.id, tool_name: tc.function.name },
        )
      }
      return { content, isError }
    }

    const applyResult = (tc: TC, res: ExecResult) => {
      // B2: shrink oversize delegation results before they hit history. The
      // full text is already persisted in the tool_result event above.
      let historyContent = res.content
      if (
        !res.isError &&
        (tc.function.name === 'delegate_to' || tc.function.name === 'delegate_parallel')
      ) {
        historyContent = summarizeLargeDelegationResult(res.content)
      }
      history.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: historyContent,
        _ts: Date.now(),
      })
      // B1: once a skill script succeeds, reference docs read earlier are
      // dead weight on the prompt. Elide them in-place.
      if (!res.isError && tc.function.name === 'run_skill_script') {
        let skillName = ''
        try {
          skillName = String(
            (JSON.parse(tc.function.arguments || '{}') as { skill?: string }).skill ?? '',
          )
        } catch {
          /* ignore */
        }
        if (skillName) elideReadSkillFileResults(history, skillName)
      }
    }

    for (const run of runs) {
      if (run.kind === 'serial' || run.items.length === 1) {
        for (const tc of run.items) {
          const gen = executeOne(tc)
          let step = await gen.next()
          while (!step.done) {
            yield step.value
            step = await gen.next()
          }
          applyResult(tc, step.value)
        }
      } else {
        // Parallel: kick off every tc under a pLimit semaphore sized to
        // this run's class (safe_parallel → toolParallelMax, e.g. 10 for
        // cheap I/O; parallel_trajectory → parallelDelegationMax, e.g. 4
        // for LLM-stream fan-out). partitionRuns already split oversize
        // buckets to ≤ cap, so this limit is effectively a no-op for the
        // common case and defence-in-depth for future regressions.
        // Events interleave via AsyncQueue so callers see them as they
        // arrive. Results land in a slot array so history.push remains
        // in index order — provider chat history requires tool_result
        // ordering to match tool_call ordering.
        const runCap =
          run.cls === 'parallel_trajectory' ? parallelTrajCap : safeParallelCap
        const limit = pLimit(runCap)
        const n = run.items.length
        type Item =
          | { kind: 'event'; event: Event }
          | { kind: 'done'; index: number; result: ExecResult }
        const queue = new AsyncQueue<Item>()
        const results: Array<ExecResult | null> = new Array(n).fill(null)

        for (let i = 0; i < n; i++) {
          const tc = run.items[i]!
          const idx = i
          void limit(async () => {
            try {
              const gen = executeOne(tc)
              let step = await gen.next()
              while (!step.done) {
                queue.push({ kind: 'event', event: step.value })
                step = await gen.next()
              }
              queue.push({ kind: 'done', index: idx, result: step.value })
            } catch (exc) {
              queue.push({
                kind: 'done',
                index: idx,
                result: {
                  content: `ERROR: ${exc instanceof Error ? exc.message : String(exc)}`,
                  isError: true,
                },
              })
            }
          })
        }

        let completed = 0
        while (completed < n) {
          const item = await queue.pop()
          if (item.kind === 'event') {
            yield item.event
          } else {
            results[item.index] = item.result
            completed += 1
          }
        }
        for (let i = 0; i < n; i++) {
          applyResult(run.items[i]!, results[i] as ExecResult)
        }
      }
    }
  }

  yield makeEvent(
    'node_finished',
    sessionId,
    {
      _turn_marker: true,
      output: assembledText,
      stop_reason: stopReason,
    },
    { depth, node_id: node.id },
  )
}

// -------- S3 fork: child first-turn streaming --------

interface StreamTurnForkOpts {
  sessionId: string
  team: TeamSpec
  node: AgentSpec
  history: ChatMessage[]
  systemPromptOverride: string
  toolsOverride: ToolSpec[]
  providerId: string
  model: string
  depth: number
}

/**
 * Streaming-only variant of `streamTurn` used for fork children's first turn.
 *
 * Key differences vs `streamTurn`:
 *   - Does NOT push assistant/tool_result into history (the history array
 *     shares entries with the parent's snapshot — mutations would break
 *     sibling prefix byte-identity).
 *   - Does NOT auto-execute tool calls. If the child emits `tool_calls`, we
 *     emit `_turn_marker` with `stop_reason: 'tool_calls'` and let the caller
 *     transition to the fresh `runNode` path.
 *   - Passes `useExactTools` + `overrideSystem` down to the provider.
 *
 * The `history` here is the one built by `buildForkedMessages` — it already
 * contains the synthetic `tool_result + user` tail, so `buildMessages` just
 * prepends the (same-bytes) system prompt. `overrideSystem` then ensures the
 * claude provider skips `splitSystem` synthesis.
 */
async function* streamTurnFork(opts: StreamTurnForkOpts): AsyncGenerator<Event> {
  const { sessionId, team, node, history, depth } = opts
  const messages = buildMessages(opts.systemPromptOverride, history)

  const systemChars = opts.systemPromptOverride.length
  const toolsChars = opts.toolsOverride.length > 0 ? JSON.stringify(opts.toolsOverride).length : 0
  let historyChars = 0
  for (const m of history) {
    if (typeof m.content === 'string') historyChars += m.content.length
    else if (Array.isArray(m.content)) historyChars += JSON.stringify(m.content).length
    if (Array.isArray(m.tool_calls)) historyChars += JSON.stringify(m.tool_calls).length
  }

  const textBuf: string[] = []
  let sawToolCall = false
  let stopReason = 'stop'

  for await (const delta of stream(
    opts.providerId,
    opts.model,
    messages,
    opts.toolsOverride.length > 0 ? opts.toolsOverride : undefined,
    { useExactTools: true, overrideSystem: opts.systemPromptOverride },
  )) {
    if (delta.kind === 'text') {
      textBuf.push(delta.text)
      yield makeEvent('token', sessionId, { text: delta.text }, { depth, node_id: node.id })
    } else if (delta.kind === 'tool_call') {
      sawToolCall = true
    } else if (delta.kind === 'usage') {
      try {
        const slugs = state().teamSlugs.get(sessionId) ?? null
        recordUsage({
          sessionId,
          companyId: slugs ? slugs[0] : null,
          teamId: team.id,
          agentId: node.id,
          agentRole: node.role,
          providerId: opts.providerId,
          model: opts.model,
          inputTokens: delta.input_tokens ?? 0,
          outputTokens: delta.output_tokens ?? 0,
          cacheReadTokens: delta.cache_read_tokens ?? 0,
          cacheWriteTokens: delta.cache_write_tokens ?? 0,
          systemChars,
          toolsChars,
          historyChars,
        })
      } catch {
        /* swallow */
      }
    } else if (delta.kind === 'stop') {
      stopReason = delta.reason ?? 'stop'
      break
    }
  }

  const assembledText = textBuf.join('').trim()
  const effectiveStop = sawToolCall ? 'tool_calls' : stopReason
  yield makeEvent(
    'node_finished',
    sessionId,
    { _turn_marker: true, output: assembledText, stop_reason: effectiveStop },
    { depth, node_id: node.id },
  )
}

interface RunNodeForkedOpts {
  sessionId: string
  team: TeamSpec
  parentNode: AgentSpec
  parentToolCallId: string
  siblingIndex: number
  siblingCount: number
  node: AgentSpec
  task: string
  depth: number
  snapshot: TurnSnapshot
  /** Inherited from the parent delegation's `mode`. Forked round-2+ falls
   *  through to runNode and needs the same visibility so any skill tool
   *  calls the child makes honour the parent's research/produce intent. */
  visibility?: 'user' | 'scratch'
}

/**
 * S3 fork: first-turn run a child with the parent's byte-identical prefix,
 * then (if the child needs more turns) transition into the normal `runNode`
 * loop with a prior-draft carry-over.
 *
 * Fork children emit the same `node_started` / `token` / `node_finished`
 * triad as `runNode` — plus a `fork.spawned` observability event.
 */
async function* runNodeForked(opts: RunNodeForkedOpts): AsyncGenerator<Event> {
  const {
    sessionId,
    team,
    parentNode,
    parentToolCallId,
    siblingIndex,
    siblingCount,
    node,
    task,
    depth,
    snapshot,
  } = opts

  yield makeEvent(
    'node_started',
    sessionId,
    { role: node.role, task, fork: true },
    { depth, node_id: node.id },
  )

  const childHistory = buildForkedMessages({
    snapshot,
    parentToolCallId,
    siblingIndex,
    siblingCount,
    parentRole: parentNode.role,
    parentId: parentNode.id,
    childRole: node.role,
    task,
  })

  // Observability: total prefix chars (system + serialized history).
  let prefixChars = snapshot.systemPrompt.length
  for (const m of snapshot.history) {
    if (typeof m.content === 'string') prefixChars += m.content.length
    else if (Array.isArray(m.content)) prefixChars += JSON.stringify(m.content).length
    if (Array.isArray(m.tool_calls)) prefixChars += JSON.stringify(m.tool_calls).length
  }
  yield makeEvent(
    'fork.spawned',
    sessionId,
    {
      parent_node_id: parentNode.id,
      child_node_id: node.id,
      sibling_index: siblingIndex,
      sibling_count: siblingCount,
      system_prompt_chars: snapshot.systemPrompt.length,
      prefix_chars: prefixChars,
      tool_count: snapshot.tools.length,
    },
    { depth, node_id: node.id },
  )

  let firstTurnOutput = ''
  let stopReason: string | undefined
  for await (const ev of streamTurnFork({
    sessionId,
    team,
    node,
    history: childHistory,
    systemPromptOverride: snapshot.systemPrompt,
    toolsOverride: snapshot.tools,
    providerId: snapshot.providerId,
    model: snapshot.model,
    depth,
  })) {
    if (ev.kind === 'node_finished' && ev.data._turn_marker === true) {
      stopReason = ev.data.stop_reason as string | undefined
      firstTurnOutput = (ev.data.output as string | undefined) ?? ''
      break
    }
    yield ev
  }

  if (stopReason !== 'tool_calls') {
    yield makeEvent(
      'node_finished',
      sessionId,
      { output: firstTurnOutput },
      { depth, node_id: node.id },
    )
    return
  }

  // Child wants more rounds — fall through to the fresh `runNode` loop with
  // the first-turn draft preserved in the task payload. This loses the cache
  // benefit for round 2+, but keeps provider/tools consistency for a child
  // that's escalating into its own delegation / skill calls.
  yield* runNode({
    sessionId,
    team,
    node,
    task: `${task}\n\n[PRIOR DRAFT]\n${firstTurnOutput}`,
    depth,
    visibility: opts.visibility,
  })
}

// -------- delegation --------

function delegateTool(team: TeamSpec, node: AgentSpec): Tool {
  const subs = teamSubordinates(team, node.id)
  const roleCounts: Record<string, number> = {}
  for (const s of subs) roleCounts[s.role] = (roleCounts[s.role] ?? 0) + 1
  const seen: Record<string, number> = {}
  const canonical: string[] = []
  const specialtyLines: string[] = []
  for (const s of subs) {
    seen[s.role] = (seen[s.role] ?? 0) + 1
    const dup = (roleCounts[s.role] ?? 0) > 1
    const key = dup ? `${s.role}#${s.id}` : s.role
    canonical.push(key)
    const labelHint = s.label && s.label !== s.role ? ` — ${s.label}` : ''
    const skills = Array.isArray(s.skills) ? s.skills.slice(0, 3) : []
    const skillHint = skills.length > 0 ? ` [skills: ${skills.join(', ')}]` : ''
    if (labelHint || skillHint) {
      specialtyLines.push(`- ${key}${labelHint}${skillHint}`)
    }
  }
  const assigneeDesc =
    specialtyLines.length > 0
      ? `Who should do the task. Must be one of your direct reports.\n${specialtyLines.join('\n')}`
      : 'Who should do the task. Must be one of your direct reports.'
  return {
    name: 'delegate_to',
    description: delegateToGuidance(),
    parameters: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          enum: canonical,
          description: assigneeDesc,
        },
        task: {
          type: 'string',
          description: 'Clear instructions for the subordinate. Include context.',
        },
        mode: {
          type: 'string',
          enum: ['research', 'verify', 'produce'],
          description:
            "research/verify = worker reports findings in prose only; any files it creates go to private scratch storage and do NOT appear as user artifacts. produce = worker creates the single user-facing deliverable (one file per delegation) based on YOUR synthesized spec. Use 'produce' only after you have synthesized research findings into a concrete file spec.",
        },
      },
      required: ['assignee', 'task', 'mode'],
    },
    handler: async () => 'delegation handled by engine',
    hint: 'Delegating…',
  }
}

interface DelegationOpts {
  sessionId: string
  team: TeamSpec
  fromNode: AgentSpec
  args: Record<string, unknown>
  toolCallId: string
  depth: number
}

async function* runDelegation(opts: DelegationOpts): AsyncGenerator<Event> {
  const { sessionId, team, fromNode, args, toolCallId, depth } = opts
  const assigneeKey = String(args.assignee ?? '')
  const task = String(args.task ?? '')
  // Delegation mode decides the sub-agent's file-write visibility:
  //   research/verify → scratch (internal; never a user artifact)
  //   produce          → user   (creates THE deliverable)
  // Missing/invalid defaults to 'produce' for back-compat with legacy teams
  // that haven't been retrained on the mode parameter. Lead prompts push
  // models toward explicit research-before-produce.
  const rawMode = String((args as Record<string, unknown>).mode ?? '')
  const childVisibility: 'user' | 'scratch' =
    rawMode === 'research' || rawMode === 'verify' ? 'scratch' : 'user'

  const subs = teamSubordinates(team, fromNode.id)
  let target: AgentSpec | null = null
  if (assigneeKey.includes('#')) {
    const [role, aid] = assigneeKey.split('#', 2)
    target = subs.find((s) => s.id === aid && s.role === role) ?? null
  }
  if (!target) {
    const matches = subs.filter((s) => s.role === assigneeKey)
    target = matches[0] ?? null
  }

  if (!target) {
    yield makeEvent(
      'delegation_closed',
      sessionId,
      { error: true, result: `No such subordinate: ${assigneeKey}` },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }

  const pairKey = `${sessionId}:${fromNode.id}->${target.id}`
  const delegationCap =
    team.limits.max_delegations_per_pair_per_turn ??
    MAX_DELEGATIONS_PER_PAIR_FALLBACK
  const prior = state().delegations.get(pairKey) ?? 0
  if (prior >= delegationCap) {
    yield makeEvent(
      'delegation_closed',
      sessionId,
      {
        assignee_id: target.id,
        assignee_role: target.role,
        error: true,
        result:
          `NOTE: delegation cap reached — you've already called delegate_to(${target.role}) ` +
          `${delegationCap} times this turn (cap resets when the user sends the ` +
          `next message). The cap exists to stop "REVISED TASK" spam, not to end the turn. ` +
          `Do one of: (a) consolidate the ${target.role} results you already have into your ` +
          `own answer, (b) hand off a CLEARLY different subtask to a different subordinate, ` +
          `or (c) tell the user plainly what's blocking and ask for guidance — do NOT ` +
          `silently close the turn with a vague "system limit" message.`,
      },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }

  if (errors.isAgentExcluded(sessionId, target.id)) {
    const msg = errors.renderError(
      { kind: 'agent_excluded', statusCode: null, detail: '' },
      {
        role: target.role,
        agentId: target.id,
        provider: target.provider_id,
        model: target.model,
      },
    )
    yield makeEvent(
      'delegation_closed',
      sessionId,
      {
        assignee_id: target.id,
        assignee_role: target.role,
        error: true,
        result: msg,
      },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }

  // Commit the cap slot only now that we know we'll actually launch the sub
  // (agent_excluded above would charge for a no-launch otherwise). We'll
  // refund it below if the sub-agent ends up making zero tool calls — that's
  // a "just asked a clarifying question, no work done" no-op delegation and
  // shouldn't eat into the parent's per-turn budget.
  state().delegations.set(pairKey, prior + 1)

  yield makeEvent(
    'delegation_opened',
    sessionId,
    {
      assignee_id: target.id,
      assignee_role: target.role,
      task,
    },
    { depth, node_id: fromNode.id, tool_call_id: toolCallId },
  )

  let subOutput = ''
  let subToolCallCount = 0
  try {
    for await (const ev of runNode({
      sessionId,
      team,
      node: target,
      task,
      depth: depth + 1,
      visibility: childVisibility,
    })) {
      if (
        ev.kind === 'tool_called' &&
        ev.depth === depth + 1 &&
        ev.node_id === target.id
      ) {
        subToolCallCount += 1
      }
      if (ev.kind === 'node_finished' && ev.depth === depth + 1 && ev.node_id === target.id) {
        subOutput = (ev.data.output as string | undefined) ?? ''
      }
      yield ev
    }
  } catch (exc) {
    errors.noteAgentFailure(sessionId, target.id)
    const classified = errors.classify(exc)
    const msg = errors.renderError(classified, {
      role: target.role,
      agentId: target.id,
      provider: target.provider_id,
      model: target.model,
    })
    // Crashed sub-agents (provider error, transient failure) shouldn't count
    // against the per-turn cap — the parent deserves to retry.
    refundDelegationSlot(pairKey)
    // S4: record errored sub-agent run to the work ledger.
    {
      const slugs = state().teamSlugs.get(sessionId) ?? null
      if (slugs) {
        await maybeWriteLedger({
          sessionId,
          team,
          target,
          task,
          output: msg,
          status: 'errored',
          companySlug: slugs[0],
        })
      }
    }
    yield makeEvent(
      'delegation_closed',
      sessionId,
      {
        assignee_id: target.id,
        assignee_role: target.role,
        error: true,
        result: msg,
      },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }

  // Refund the cap slot if the sub-agent finished without calling any tool —
  // that means it only produced text (typically a clarifying question to
  // bounce back up), which is effectively a no-op delegation. Without this
  // refund the parent can burn the whole per-turn budget in a single round of
  // clarifications and hit "cap reached" when retrying with the answer.
  if (subToolCallCount === 0) {
    refundDelegationSlot(pairKey)
  }

  // S4: record completed sub-agent run to the work ledger (raw subOutput
  //   preserved on disk for cross-session recall — capping below only
  //   affects the parent's in-memory history).
  {
    const slugs = state().teamSlugs.get(sessionId) ?? null
    if (slugs) {
      await maybeWriteLedger({
        sessionId,
        team,
        target,
        task,
        output: subOutput,
        status: 'completed',
        companySlug: slugs[0],
      })
    }
  }

  // ★ S1: cap + summarise sub-agent output before injecting it into the
  //   parent's tool_result history. Without this a 200KB report body
  //   blows out the Lead's context window and burns provider quota.
  const strategy: SummaryStrategy =
    (target.result_cap?.strategy as SummaryStrategy | undefined) ??
    (process.env.OPENHIVE_RESULT_SUMMARY_STRATEGY as SummaryStrategy | undefined) ??
    'heuristic'
  const envMax = Number(process.env.OPENHIVE_RESULT_MAX_CHARS)
  const maxChars =
    target.result_cap?.max_chars ??
    (Number.isFinite(envMax) && envMax > 0 ? envMax : MAX_CHILD_RESULT_CHARS)

  const capped = await capAndSummarise({
    raw: subOutput,
    node: target,
    sessionId,
    toolCallId,
    strategy,
    maxChars,
  })


  yield makeEvent(
    'delegation_closed',
    sessionId,
    {
      assignee_id: target.id,
      assignee_role: target.role,
      result: capped.result,
      ...(capped.truncated && {
        truncated: true,
        original_chars: capped.originalChars,
        summary_strategy: capped.summaryStrategy,
      }),
      ...(capped.artifactPaths.length > 0 && {
        artifact_paths: capped.artifactPaths,
      }),
    },
    { depth, node_id: fromNode.id, tool_call_id: toolCallId },
  )
}

// -------- parallel delegation --------

function delegateParallelTool(team: TeamSpec, node: AgentSpec): Tool {
  const subs = teamSubordinates(team, node.id)
  const eligible = subs.filter((s) => s.max_parallel > 1)
  const allRoles = subs.map((s) => s.role)
  const roleCounts: Record<string, number> = {}
  for (const r of allRoles) roleCounts[r] = (roleCounts[r] ?? 0) + 1
  const canonicalById: Record<string, string> = {}
  const seen: Record<string, number> = {}
  for (const s of subs) {
    seen[s.role] = (seen[s.role] ?? 0) + 1
    const dup = (roleCounts[s.role] ?? 0) > 1
    canonicalById[s.id] = dup ? `${s.role}#${s.id}` : s.role
  }
  const enumValues = eligible.map((s) => canonicalById[s.id]!).filter(Boolean)
  const capsHint = eligible.map((s) => `${canonicalById[s.id]} ≤ ${s.max_parallel}`).join(', ')
  const maxOfAll = eligible.reduce((m, s) => Math.max(m, s.max_parallel), 1)

  return {
    name: 'delegate_parallel',
    description:
      'Delegate the SAME subordinate to multiple concurrent instances, each with ' +
      'a distinct, non-overlapping task. Use ONLY when the work splits cleanly ' +
      'across independent regions — a higher ceiling is not a quota, pick the ' +
      `smallest count that actually covers the work. Per-assignee ceilings: ${capsHint}. ` +
      "Each task must describe its own scope so the instances don't duplicate effort.",
    parameters: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          enum: enumValues,
          description: 'Which subordinate to run in parallel.',
        },
        tasks: {
          type: 'array',
          minItems: 2,
          maxItems: maxOfAll,
          items: { type: 'string' },
          description:
            'One task per parallel instance. Each must be self-contained. ' +
            "Length is also bounded by the chosen assignee's ceiling.",
        },
        mode: {
          type: 'string',
          enum: ['research', 'verify', 'produce'],
          description:
            'Same semantics as delegate_to.mode — applies to EVERY parallel sibling. research/verify keep all child file outputs in private scratch; produce lets each child write one user-visible artifact (rare with fan-out; usually research).',
        },
      },
      required: ['assignee', 'tasks', 'mode'],
    },
    handler: async () => 'delegate_parallel handled by engine',
    hint: 'Fanning out…',
  }
}

async function* runParallelDelegation(opts: DelegationOpts): AsyncGenerator<Event> {
  const { sessionId, team, fromNode, args, toolCallId, depth } = opts
  const assigneeKey = String(args.assignee ?? '')
  const tasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : []
  const rawMode = String((args as Record<string, unknown>).mode ?? '')
  const childVisibility: 'user' | 'scratch' =
    rawMode === 'research' || rawMode === 'verify' ? 'scratch' : 'user'

  const subs = teamSubordinates(team, fromNode.id)
  let target: AgentSpec | null = null
  if (assigneeKey.includes('#')) {
    const [role, aid] = assigneeKey.split('#', 2)
    target = subs.find((s) => s.id === aid && s.role === role) ?? null
  }
  if (!target) {
    const matches = subs.filter((s) => s.role === assigneeKey)
    target = matches[0] ?? null
  }
  if (!target) {
    yield makeEvent(
      'delegation_closed',
      sessionId,
      {
        group_final: true,
        error: true,
        result: `No such subordinate: ${assigneeKey}`,
      },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }

  const maxN = target.max_parallel
  if (maxN <= 1) {
    yield makeEvent(
      'delegation_closed',
      sessionId,
      {
        group_final: true,
        error: true,
        result:
          `ERROR: ${target.role} is not configured for parallel dispatch ` +
          '(max_parallel=1). Use delegate_to instead.',
      },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }
  if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > maxN) {
    yield makeEvent(
      'delegation_closed',
      sessionId,
      {
        group_final: true,
        error: true,
        result:
          `ERROR: delegate_parallel to ${target.role} requires 2..${maxN} tasks; ` +
          `got ${tasks.length}.`,
      },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }

  const siblingGroupId = newId('sib')
  const queue = new AsyncQueue<{ index: number; event: Event | null }>()
  const outputs: string[] = tasks.map(() => '')
  const errs: (string | null)[] = tasks.map(() => null)
  const capturedTarget = target

  // S3 fork: read the parent's turn snapshot once (same for every sibling)
  // and decide per-child whether to fork. Mixed-provider fan-outs decide
  // independently — claude children fork, codex children fall back to fresh.
  const parentSnapshot = state().lastTurnSnapshot.get(sessionId)

  const runOne = async (i: number, taskText: string): Promise<void> => {
    try {
      const decision = decideForkOrFresh({
        snapshot: parentSnapshot,
        parent: fromNode,
        child: capturedTarget,
        depth,
      })

      if (!decision.fork) {
        queue.push({
          index: i,
          event: makeEvent(
            'fork.skipped',
            sessionId,
            {
              parent_node_id: fromNode.id,
              child_node_id: capturedTarget.id,
              reason: decision.reason ?? 'no_snapshot',
            },
            { depth, node_id: fromNode.id },
          ),
        })
      }

      const childIter = decision.fork
        ? runNodeForked({
            sessionId,
            team,
            parentNode: fromNode,
            parentToolCallId: toolCallId,
            siblingIndex: i,
            siblingCount: tasks.length,
            node: capturedTarget,
            task: taskText,
            depth: depth + 1,
            snapshot: decision.snapshot!,
            visibility: childVisibility,
          })
        : runNode({
            sessionId,
            team,
            node: capturedTarget,
            task: taskText,
            depth: depth + 1,
            visibility: childVisibility,
          })

      for await (const ev of childIter) {
        if (ev.data.sibling_group_id === undefined) {
          ev.data.sibling_group_id = siblingGroupId
        }
        if (ev.data.sibling_index === undefined) ev.data.sibling_index = i
        queue.push({ index: i, event: ev })
        if (ev.kind === 'node_finished' && ev.depth === depth + 1) {
          outputs[i] = (ev.data.output as string | undefined) ?? ''
        }
      }
    } catch (exc) {
      errors.noteAgentFailure(sessionId, capturedTarget.id)
      const classified = errors.classify(exc)
      errs[i] = errors.renderError(classified, {
        role: capturedTarget.role,
        agentId: capturedTarget.id,
        provider: capturedTarget.provider_id,
        model: capturedTarget.model,
      })
    } finally {
      queue.push({ index: i, event: null })
    }
  }

  yield makeEvent(
    'delegation_opened',
    sessionId,
    {
      assignee_id: target.id,
      assignee_role: target.role,
      task: `[parallel x${tasks.length}]`,
      sibling_group_id: siblingGroupId,
      parallel: true,
      count: tasks.length,
    },
    { depth, node_id: fromNode.id, tool_call_id: toolCallId },
  )

  const workers = tasks.map((t, i) => runOne(i, String(t)))
  let remaining = tasks.length
  while (remaining > 0) {
    const msg = await queue.pop()
    if (msg.event === null) {
      remaining -= 1
      continue
    }
    yield msg.event
  }
  await Promise.allSettled(workers)

  const parts: string[] = []
  for (let i = 0; i < outputs.length; i += 1) {
    if (errs[i] !== null) parts.push(`[#${i + 1} FAILED] ${errs[i]}`)
    else if (outputs[i]) parts.push(`[#${i + 1}] ${outputs[i]}`)
  }
  const combined = parts.length > 0 ? parts.join('\n\n') : '(no output)'
  const anyError = errs.some((e) => e !== null)
  const allError = errs.every((e) => e !== null)

  // S4: record one ledger entry per parallel sibling (not per group).
  {
    const slugs = state().teamSlugs.get(sessionId) ?? null
    if (slugs) {
      for (let i = 0; i < tasks.length; i += 1) {
        const errMsg = errs[i]
        await maybeWriteLedger({
          sessionId,
          team,
          target: capturedTarget,
          task: String(tasks[i]),
          output: errMsg ?? outputs[i] ?? '',
          status: errMsg ? 'errored' : 'completed',
          companySlug: slugs[0],
        })
      }
    }
  }

  yield makeEvent(
    'delegation_closed',
    sessionId,
    {
      assignee_id: target.id,
      assignee_role: target.role,
      sibling_group_id: siblingGroupId,
      group_final: true,
      result: combined,
      error: anyError && allError,
    },
    { depth, node_id: fromNode.id, tool_call_id: toolCallId },
  )
}

// -------- ask_user --------

function askUserTool(): Tool {
  return {
    name: 'ask_user',
    description: askUserGuidance(),
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string', description: 'Short chip label, ≤12 chars' },
              multiSelect: { type: 'boolean', default: false },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label', 'description'],
                },
              },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
        },
      },
      required: ['questions'],
    },
    handler: async () => 'ask_user handled by engine',
    hint: 'Asking user…',
  }
}

interface AskUserOpts {
  sessionId: string
  team: TeamSpec
  node: AgentSpec
  args: Record<string, unknown>
  toolCallId: string
  depth: number
}

async function* runAskUser(opts: AskUserOpts): AsyncGenerator<Event> {
  const { sessionId, team, node, args, toolCallId, depth } = opts
  const questions = Array.isArray(args.questions) ? args.questions : []

  const askUserCap =
    team.limits.max_ask_user_per_turn ?? MAX_ASK_USER_PER_TURN_FALLBACK
  const count = state().askUser.get(sessionId) ?? 0
  if (count >= askUserCap) {
    yield makeEvent(
      'user_answered',
      sessionId,
      {
        error: true,
        result: `NOTE: ask_user cap reached (${askUserCap} per turn, resets when the user sends the next message). Proceed with best-effort assumptions and surface remaining uncertainties in your final answer instead of silently ending the turn.`,
      },
      { depth, node_id: node.id, tool_call_id: toolCallId },
    )
    return
  }
  state().askUser.set(sessionId, count + 1)

  yield makeEvent(
    'user_question',
    sessionId,
    { questions, agent_role: node.role },
    { depth, node_id: node.id, tool_call_id: toolCallId },
  )

  let payload: Record<string, unknown>
  try {
    payload = await askuser.register(toolCallId)
  } catch {
    yield makeEvent(
      'user_answered',
      sessionId,
      { error: true, result: 'ERROR: question cancelled.' },
      { depth, node_id: node.id, tool_call_id: toolCallId },
    )
    return
  }

  const answers = (payload.answers as Record<string, unknown> | undefined) ?? {}
  const skipped = !!payload.skipped
  const resultText = skipped ? 'skipped' : JSON.stringify(answers)

  yield makeEvent(
    'user_answered',
    sessionId,
    { result: resultText, skipped },
    { depth, node_id: node.id, tool_call_id: toolCallId },
  )
}

// -------- skill invocation sub-generator --------

interface SkillInvocationOpts {
  sessionId: string
  tool: Tool
  args: Record<string, unknown>
  toolCallId: string
  toolName: string
  nodeId: string
  depth: number
}

/** Runs a skill tool while emitting `skill.queued` + `skill.started` events
 *  around the concurrency-limiter boundary. The concurrency limiter fires
 *  `onQueued` synchronously (before the FIFO wait) and `onStarted` once the
 *  slot is actually acquired. We translate those callbacks into events and
 *  yield them at the right time using a deferred promise so the yield order
 *  matches real execution order even under contention.
 *
 *  Yields one synthetic `tool_result` event at the end carrying the handler's
 *  return value in `data.content`; the caller unwraps it and emits the
 *  canonical `tool_result` in the outer loop. */
async function* runSkillInvocation(opts: SkillInvocationOpts): AsyncGenerator<Event> {
  const { sessionId, tool, args, toolCallId, toolName, nodeId, depth } = opts
  if (!tool.skill) {
    throw new Error(`runSkillInvocation called on non-skill tool ${toolName}`)
  }

  let queuedFired = false
  let resolveStarted: () => void = () => {}
  const startedPromise = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })

  // Fire the skill call immediately. onQueued runs synchronously inside
  // runWithHooks before any await, so by the time this function returns
  // (after the first await) queuedFired is already true.
  let resultContent = ''
  let resultError = false
  const invocationPromise = (async () => {
    try {
      const raw = await tool.skill!.runWithHooks(args, {
        onQueued: () => {
          queuedFired = true
        },
        onStarted: () => {
          resolveStarted()
        },
      })
      resultContent = typeof raw === 'string' ? raw : JSON.stringify(raw)
    } catch (exc) {
      resultContent = `ERROR: ${exc instanceof Error ? exc.message : String(exc)}`
      resultError = true
      // Make sure we don't hang on startedPromise if the call threw before
      // the slot was acquired.
      resolveStarted()
    }
  })()

  // Yield microtask so synchronous onQueued has already fired.
  await Promise.resolve()
  if (queuedFired) {
    yield makeEvent(
      'skill.queued',
      sessionId,
      { skill: tool.skill.name },
      { depth, node_id: nodeId, tool_call_id: toolCallId, tool_name: toolName },
    )
  }

  // Wait until the slot is acquired (or the call fails early).
  await startedPromise
  yield makeEvent(
    'skill.started',
    sessionId,
    { skill: tool.skill.name },
    { depth, node_id: nodeId, tool_call_id: toolCallId, tool_name: toolName },
  )

  await invocationPromise

  // Relay the handler result back to the caller via a synthetic tool_result
  // event. The caller strips this and emits the canonical tool_result.
  yield makeEvent(
    'tool_result',
    sessionId,
    { content: resultContent, is_error: resultError },
    { depth, node_id: nodeId, tool_call_id: toolCallId, tool_name: toolName },
  )
}

// -------- agent-skill plumbing (progressive disclosure) --------

// 2026-04-23: CLARIFICATION_REQUEST cascade removed. Previously sub-agents
// prefixed ambiguity with a sentinel that the Lead would mechanically convert
// to ask_user — which caused ask_user overuse (any ambiguity bubbled all the
// way up as a user-facing question). New pattern: sub-agents self-resolve by
// picking the most plausible interpretation and stating their assumption;
// Lead verifies assumptions, corrects silently, and only calls ask_user as a
// genuine last resort (see askUserGuidance()).

function buildRelaySection(
  depth: number,
  hasSubs: boolean,
  team: TeamSpec,
): string {
  if (depth === 0) {
    // Lead-specific engine rules. Behavioural playbook (register, ask_user
    // policy, artifact citation, meta-label ban, trivial-vs-substantive
    // response shape) lives in DEFAULT_LEAD_SYSTEM_PROMPT — not duplicated
    // here.
    const delegationCap =
      team.limits.max_delegations_per_pair_per_turn ??
      MAX_DELEGATIONS_PER_PAIR_FALLBACK
    return (
      '# User gateway\n' +
      'Only you can address the user. Never end a turn with plain text ' +
      'requesting input ("링크 주세요" etc.) — that finalises the run. Use ' +
      '`ask_user` per its description for genuine stuck-points only.\n' +
      `\n# Delegation budget per turn\n` +
      `You may call \`delegate_to\` on each subordinate at most ${delegationCap} times ` +
      `per turn (the budget resets when the user sends the next message). When a delegate ` +
      `returns a usable result, accept it or edit yourself — do NOT re-delegate ` +
      `"REVISED TASK" / "please polish X". If you hit the cap mid-turn, consolidate what you ` +
      `have and report to the user; don't end the turn with a vague "system limit" excuse.\n` +
      `\n# Parallel fan-out (independent subtasks)\n` +
      `If two or more subtasks are genuinely independent (no output of one feeds the other), ` +
      `emit MULTIPLE \`delegate_to\` tool_calls in the SAME assistant response — the engine runs ` +
      `them concurrently and you'll see each tool_result as it arrives. Do NOT chain them across ` +
      `turns when they don't need to be sequential. Use this ONLY when the tasks are truly ` +
      `independent; if one's output shapes the other (research → then write report), keep them ` +
      `sequential so the second sees the first's result.\n`
    )
  }
  let section =
    '# User contact (you are NOT the user gateway)\n' +
    'Only the Lead can talk to the user. You cannot call `ask_user` — it is not ' +
    'in your tool catalog.\n' +
    '\n# Handling ambiguity in your task (self-resolve)\n' +
    'If the task brief leaves something ambiguous, do NOT ask back. Pick the ' +
    'single most plausible interpretation, state it as a short explicit ' +
    'assumption at the top of your result (a single line starting with ' +
    '"Assumption:" in the task\'s working language), and deliver the best work ' +
    'under that assumption. Your parent will verify. Picking-and-delivering ' +
    'with a stated assumption is always better than kicking the decision upward.\n' +
    '\n# Artifacts — do NOT fabricate URIs (hard rule)\n' +
    'NEVER write an `artifact://...` URI in your result unless you actually ' +
    'produced that file THIS turn via a skill tool call (e.g. `run_skill_script`, ' +
    'a typed skill like `pdf` / `image-gen` / `text-file` / `docx` / `pptx`). ' +
    'Inventing plausible-looking URIs is a hard fault — the engine validates ' +
    'your output against the session artifact index and will strip fake URIs ' +
    'before returning to your parent. If you cannot produce the requested file ' +
    '(no appropriate skill in your tool catalog, or the tool call failed), say ' +
    'so plainly: "요청한 파일을 생성할 수 없습니다 — 이 에이전트에 적합한 ' +
    'skill (pdf / docx / …) 이 연결되어 있지 않습니다." Do NOT pretend.\n'
  if (hasSubs) {
    section +=
      '\n# Relaying from your own delegates\n' +
      'If one of your own delegates returns ambiguity or fails, resolve it ' +
      'yourself or retry with a tighter brief. Do NOT forward their uncertainty ' +
      'upward; you are the decision-maker at this level.\n'
  }
  return section
}

function describeTeamForAgent(team: TeamSpec, agentId: string): string {
  // Recursively walks the delegation tree rooted at this agent and produces a
  // markdown outline. Lets the LLM see past its immediate reports so it can
  // pick the right direct delegate even when the actual specialist lives
  // two+ levels down (direct delegation is still limited to one hop — the
  // intermediate manager must relay).
  const direct = teamSubordinates(team, agentId)
  if (direct.length === 0) return ''
  const lines: string[] = []
  const visited = new Set<string>([agentId])
  const walk = (parentId: string, indent: number) => {
    for (const sub of teamSubordinates(team, parentId)) {
      if (visited.has(sub.id)) continue
      visited.add(sub.id)
      const label = sub.label && sub.label !== sub.role ? ` (${sub.label})` : ''
      // Phase F1: surface skill ownership so Lead routes "make PDF" to the
      // agent that actually has `pdf` instead of delegating blindly by role.
      const skills = Array.isArray(sub.skills) ? sub.skills : []
      const skillTag = skills.length > 0 ? ` [skills: ${skills.join(', ')}]` : ''
      lines.push(`${'  '.repeat(indent)}- ${sub.role}${label}${skillTag}`)
      walk(sub.id, indent + 1)
    }
  }
  walk(agentId, 0)
  if (lines.length === 0) return ''
  return (
    '# Your team\n' +
    '`delegate_to` reaches DIRECT reports only (top-level bullets). For deeper ' +
    'specialists, delegate to the branch parent and have them relay. Skill tags ' +
    'in [brackets] show who actually owns each skill — route file-generation ' +
    'tasks (pdf, docx, pptx, etc.) to the agent that has that skill, not to ' +
    'whoever seems vaguely related.\n\n' +
    lines.join('\n') +
    '\n'
  )
}

function composeSystemPrompt(base: string, agentSkills: SkillDef[], teamSection: string): string {
  if (agentSkills.length === 0 && !teamSection) return base
  const parts: string[] = []
  if (base) parts.push(base.trimEnd())
  if (teamSection) {
    parts.push('\n\n')
    parts.push(teamSection)
  }
  if (agentSkills.length === 0) return parts.join('')
  parts.push('\n\n# Skills available to you\n')
  parts.push(
    'You have access to the skills listed below. For each, you only see the ' +
      'name and a one-line description right now. When a task looks like it ' +
      "matches one, call `activate_skill(name)` to load that skill's full guide " +
      '(SKILL.md) and file tree into the conversation. Then use ' +
      '`read_skill_file` to fetch supplementary docs and `run_skill_script` to ' +
      'execute scripts inside it.\n',
  )
  for (const skill of agentSkills) {
    let desc = (skill.description || '(no description)').trim()
    if (desc.includes('\n')) desc = desc.split('\n', 1)[0]!.trimEnd() + ' …'
    if (desc.length > 120) desc = desc.slice(0, 120).trimEnd() + ' …'
    parts.push(`- \`${skill.name}\` — ${desc}\n`)
  }
  return parts.join('')
}

function skillActivateTool(agentSkills: SkillDef[]): Tool {
  const byName = new Map(agentSkills.map((s) => [s.name, s]))
  const names = [...byName.keys()].sort()
  return {
    name: 'activate_skill',
    description: activateSkillGuidance(),
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: names,
          description: 'Which skill to activate.',
        },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const name = String(args.name ?? '')
      const skill = byName.get(name)
      if (!skill) {
        return JSON.stringify({
          ok: false,
          error: `unknown or unauthorized skill: ${JSON.stringify(name)}`,
        })
      }
      return JSON.stringify({
        ok: true,
        name: skill.name,
        description: skill.description,
        guide: skill.body ?? '',
        hint:
          'Read SKILL.md guide above. Most skills are usable from this guide alone. ' +
          'If the guide references a file you cannot place by name, call ' +
          'list_skill_files(skill) to see the directory tree. Use ' +
          'read_skill_file(skill, path) for referenced docs and ' +
          'run_skill_script(skill, script, ...) to execute. Paths are relative ' +
          'to the skill directory.',
      })
    },
    hint: 'Activating skill…',
  }
}

function skillListFilesTool(agentSkills: SkillDef[]): Tool {
  const byName = new Map(agentSkills.map((s) => [s.name, s]))
  const names = [...byName.keys()].sort()
  return {
    name: 'list_skill_files',
    description: listSkillFilesGuidance(),
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          enum: names,
          description: 'Which loaded skill to list files for.',
        },
      },
      required: ['skill'],
    },
    handler: async (args) => {
      const name = String(args.skill ?? '')
      const skill = byName.get(name)
      if (!skill) {
        return JSON.stringify({
          ok: false,
          error: `unknown or unauthorized skill: ${JSON.stringify(name)}`,
        })
      }
      return JSON.stringify({
        ok: true,
        name: skill.name,
        files: skill.fileTree ?? [],
      })
    },
    hint: 'Listing skill files…',
  }
}

function skillReadTool(
  agentSkills: SkillDef[],
  sessionId: string,
  team: TeamSpec,
): Tool {
  const byName = new Map(agentSkills.map((s) => [s.name, s]))
  const names = [...byName.keys()].sort()
  return {
    name: 'read_skill_file',
    description:
      "Read a file inside a loaded skill's directory (references/, scripts/, " +
      'assets/, etc.). Use this to fetch supplementary docs the SKILL.md guide ' +
      "points to, or to inspect a script's source before running it.",
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          enum: names,
          description: 'Which loaded skill the file belongs to.',
        },
        path: {
          type: 'string',
          description: "Path relative to the skill directory, e.g. 'references/FORMS.md'.",
        },
      },
      required: ['skill', 'path'],
    },
    handler: async (args) => {
      const skillName = String(args.skill ?? '')
      const path = String(args.path ?? '')
      const skill = byName.get(skillName)
      if (!skill) {
        return JSON.stringify({
          ok: false,
          error: `unknown or unauthorized skill: ${JSON.stringify(skillName)}`,
        })
      }

      // Phase C3: refuse duplicates and hard-cap total.
      const key = `${skillName}:${path}`
      let seen = state().readSkillFileSeen.get(sessionId)
      if (!seen) {
        seen = new Set<string>()
        state().readSkillFileSeen.set(sessionId, seen)
      }
      if (seen.has(key)) {
        return JSON.stringify({
          ok: false,
          error:
            `already read ${JSON.stringify(key)} in this run. The prior tool_result ` +
            `is still in your conversation history — scroll back instead of re-reading.`,
        })
      }
      const total = state().readSkillFileTotal.get(sessionId) ?? 0
      const readCap =
        team.limits.max_read_skill_file_per_turn ??
        MAX_READ_SKILL_FILE_PER_TURN_FALLBACK
      if (total >= readCap) {
        return JSON.stringify({
          ok: false,
          error:
            `read_skill_file cap reached (${readCap} per turn, resets on next user message). ` +
            `Stop exploring the skill tree — commit to run_skill_script with what you already have ` +
            `or report the blocker upstream.`,
        })
      }

      const { content, error } = readSkillFile(skill, path)
      if (error) return JSON.stringify({ ok: false, error })

      // Only count successful, novel reads so binary-refusals and errors
      // don't burn the budget.
      seen.add(key)
      state().readSkillFileTotal.set(sessionId, total + 1)

      return JSON.stringify({ ok: true, path, content })
    },
    hint: 'Reading skill file…',
  }
}

interface SkillToolContext {
  sessionId: string
  team: TeamSpec
  teamSlugs: [string, string] | null
  /** The node running this skill tool. Used for per-node scratch dirs so
   *  sibling research workers don't trample each other. */
  nodeId: string
  /** 'user' = files are user-facing deliverables (go to artifacts/ + recorded
   *  in artifacts.json, visible in UI). 'scratch' = internal working files
   *  for research/verify sub-agents (go to scratch/{nodeId}/, NOT recorded —
   *  so UI/manifest automatically skip them). Lead is always 'user'. */
  visibility: 'user' | 'scratch'
}

function skillRunTool(agentSkills: SkillDef[], ctx: SkillToolContext): Tool {
  const byName = new Map(agentSkills.map((s) => [s.name, s]))
  const names = [...byName.keys()].sort()
  const companySlug = ctx.teamSlugs ? ctx.teamSlugs[0] : null
  const teamSlug = ctx.teamSlugs ? ctx.teamSlugs[1] : null
  const outputDir =
    ctx.visibility === 'scratch'
      ? sessionsStore.scratchDirForNode(ctx.sessionId, ctx.nodeId)
      : sessionsStore.artifactDirForSession(ctx.sessionId)

  return {
    name: 'run_skill_script',
    description:
      "Run a script that lives inside a loaded skill's directory. The script " +
      'is invoked from the skill dir with OPENHIVE_OUTPUT_DIR set; any files ' +
      'it writes there are auto-registered as artifacts the user can download. ' +
      'Stdout (truncated) is returned to you so you can chain calls.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: names },
        script: {
          type: 'string',
          description: "Path to the script relative to the skill dir, e.g. 'scripts/fill_form.py'.",
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional command-line arguments passed to the script.',
        },
        stdin: {
          type: 'string',
          description: "Optional text to send to the script's stdin.",
        },
      },
      required: ['skill', 'script'],
    },
    handler: async () => {
      throw new Error('run_skill_script must be invoked via runWithHooks, not handler')
    },
    hint: 'Running skill script…',
    skill: {
      name: 'run_skill_script',
      runWithHooks: async (args, hooks) => {
        const skillName = String(args.skill ?? '')
        const script = String(args.script ?? '')
        const rawScriptArgs = args.args ?? []
        if (!Array.isArray(rawScriptArgs)) {
          // Validation failure — skill never actually ran, so fire hooks
          // synchronously to keep the queued/started/result sequence intact.
          hooks.onQueued()
          hooks.onStarted()
          return JSON.stringify({ ok: false, error: "'args' must be a list of strings" })
        }
        const scriptArgs = rawScriptArgs.map((a) => String(a))
        const stdinText = args.stdin
        if (stdinText !== undefined && typeof stdinText !== 'string') {
          hooks.onQueued()
          hooks.onStarted()
          return JSON.stringify({ ok: false, error: "'stdin' must be a string" })
        }

        const skill = byName.get(skillName)
        if (!skill) {
          hooks.onQueued()
          hooks.onStarted()
          return JSON.stringify({
            ok: false,
            error: `unknown or unauthorized skill: ${JSON.stringify(skillName)}`,
          })
        }

        const result = await runSkillScript(skill, script, outputDir, {
          args: scriptArgs,
          stdinText: typeof stdinText === 'string' ? stdinText : null,
          hooks,
        })
        const registered = registerSkillArtifacts(result.files, {
          sessionId: ctx.sessionId,
          teamId: ctx.team.id,
          companySlug,
          teamSlug,
          skillName: skill.name,
          visibility: ctx.visibility,
        })
        return JSON.stringify({
          ok: result.ok,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          stdout: result.stdout,
          stderr: result.ok ? '' : result.stderr,
          files: registered,
        })
      },
    },
  }
}

// -------- skill auto-hint rendering --------

/** Compose a short "matching skills" block to prepend to the system prompt
 *  when the user's goal triggers one or more skills. Empty list → ''. The
 *  hint is advisory — the LLM still has to activate/use the skill. */
export function renderSkillHints(matches: SkillDef[]): string {
  if (matches.length === 0) return ''
  const lines = [
    '# Skill hints for this task',
    '',
    'Your current request looks like a fit for the skill(s) below. Consider ' +
      'activating one before planning from scratch.',
    '',
  ]
  for (const s of matches) {
    let desc = (s.description || '').trim()
    if (desc.includes('\n')) desc = desc.split('\n', 1)[0]!.trimEnd() + ' …'
    lines.push(`- \`${s.name}\`${desc ? ` — ${desc}` : ''}`)
  }
  return lines.join('\n') + '\n'
}

// -------- Lead task-list native tools --------

/** Render the current todos block for the system prompt. Empty list → ''.
 *  The LLM reads this on every turn so it can stay oriented on progress. */
export function renderTodosSection(todos: TodoItem[]): string {
  if (todos.length === 0) return ''
  const pending = todos.filter((t) => !t.done).length
  const done = todos.length - pending
  const header = `# Current todos (${pending} pending, ${done} done)\n\n`
  const lines = todos.map((t, i) => {
    const mark = t.done ? 'x' : ' '
    return `  ${i + 1}. [${mark}] ${t.text}  (id: ${t.id})`
  })
  return header + lines.join('\n') + '\n'
}

function todoTools(sessionId: string): Tool[] {
  const getTodos = (): TodoItem[] => state().todos.get(sessionId) ?? []
  const saveTodos = (items: TodoItem[]) => {
    state().todos.set(sessionId, items)
  }
  return [
    {
      name: 'set_todos',
      description:
        'Replace the entire todo list for this session. Use at the start of a ' +
        'complex task to lay out the plan, or to re-plan after scope changes. ' +
        'Each item becomes a pending todo with a fresh id.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of short todo descriptions (imperative voice).',
          },
        },
        required: ['items'],
      },
      handler: async (args) => {
        const raw = Array.isArray((args as { items?: unknown }).items)
          ? (args as { items: unknown[] }).items
          : []
        const items: TodoItem[] = raw
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((text) => ({ id: newId('todo'), text: text.trim(), done: false }))
        saveTodos(items)
        return JSON.stringify({ ok: true, todos: items })
      },
      hint: 'Planning todos…',
    },
    {
      name: 'add_todo',
      description:
        'Append one todo to the list. Use when a new subtask emerges mid-work ' +
        'that you want to track explicitly.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Short description.' },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const text =
          typeof (args as { text?: unknown }).text === 'string'
            ? (args as { text: string }).text.trim()
            : ''
        if (!text) return JSON.stringify({ ok: false, error: 'empty text' })
        const item: TodoItem = { id: newId('todo'), text, done: false }
        saveTodos([...getTodos(), item])
        return JSON.stringify({ ok: true, todo: item })
      },
      hint: 'Adding todo…',
    },
    {
      name: 'complete_todo',
      description:
        'Mark the todo with the given id as done. Use exactly the id shown in ' +
        'the Current todos block — not the 1-based index.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The todo id to complete.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id =
          typeof (args as { id?: unknown }).id === 'string' ? (args as { id: string }).id : ''
        const list = getTodos()
        const idx = list.findIndex((t) => t.id === id)
        if (idx < 0) {
          return JSON.stringify({ ok: false, error: `no todo with id ${id}` })
        }
        const updated = list.map((t, i) => (i === idx ? { ...t, done: true } : t))
        saveTodos(updated)
        return JSON.stringify({ ok: true, todo: updated[idx] })
      },
      hint: 'Completing todo…',
    },
  ]
}

const TODO_TOOL_NAMES = new Set(['set_todos', 'add_todo', 'complete_todo'])

// -------- typed skill tool --------

function skillTool(skill: SkillDef, ctx: SkillToolContext): Tool {
  const companySlug = ctx.teamSlugs ? ctx.teamSlugs[0] : null
  const teamSlug = ctx.teamSlugs ? ctx.teamSlugs[1] : null
  const outputDir =
    ctx.visibility === 'scratch'
      ? sessionsStore.scratchDirForNode(ctx.sessionId, ctx.nodeId)
      : sessionsStore.artifactDirForSession(ctx.sessionId)

  return {
    name: skill.name,
    description: skill.description || `Run the ${skill.name} skill.`,
    parameters: skill.parameters ?? { type: 'object', properties: {} },
    handler: async () => {
      throw new Error(`skill tool ${skill.name} must be invoked via runWithHooks, not handler`)
    },
    hint: `Running ${skill.name}…`,
    skill: {
      name: skill.name,
      runWithHooks: async (args, hooks) => {
        // Per-turn cap on `web-search`. Mirrors the `read_skill_file` cap
        // pattern: check → increment → short-circuit with a structured error
        // the LLM can read in the tool_result. Reset happens on every new
        // user message via `resetPerTurnCaps`.
        if (skill.name === 'web-search') {
          const cap =
            ctx.team.limits.max_web_search_per_turn ??
            MAX_WEB_SEARCH_PER_TURN_FALLBACK
          const used = state().webSearch.get(ctx.sessionId) ?? 0
          if (used >= cap) {
            return JSON.stringify({
              ok: false,
              error:
                `web-search cap reached (${cap} per turn, resets on next user message). ` +
                `Consolidate what you have and either web-fetch a promising URL from prior ` +
                `results, or hand back to your parent with the current findings.`,
            })
          }
          state().webSearch.set(ctx.sessionId, used + 1)
        }
        const result = await runSkill(skill, args, outputDir, { hooks })
        const registered = registerSkillArtifacts(result.files, {
          sessionId: ctx.sessionId,
          teamId: ctx.team.id,
          companySlug,
          teamSlug,
          skillName: skill.name,
          visibility: ctx.visibility,
        })
        return JSON.stringify({
          ok: result.ok,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          stdout: result.stdout,
          stderr: result.ok ? '' : result.stderr,
          files: registered,
        })
      },
    },
  }
}

// -------- MCP tool wrapper --------

function mcpTool(serverName: string, toolMeta: Record<string, unknown>): Tool {
  const toolName = typeof toolMeta.name === 'string' ? toolMeta.name : 'tool'
  const namespaced = `${serverName}__${toolName}`
  const description = typeof toolMeta.description === 'string' ? toolMeta.description.trim() : ''
  const parameters =
    toolMeta.inputSchema && typeof toolMeta.inputSchema === 'object'
      ? (toolMeta.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} }
  return {
    name: namespaced,
    description: description ? `[${serverName}] ${description}` : `[${serverName}]`,
    parameters,
    handler: async (args) => mcpManager().callTool(serverName, toolName, args),
    hint: `Calling ${serverName}…`,
  }
}

// -------- artifact helper --------

function registerSkillArtifacts(
  files: { name: string; path: string; mime: string; size: number }[],
  ctx: {
    sessionId: string
    teamId: string
    companySlug: string | null
    teamSlug: string | null
    skillName: string
    /** 'user' = register in artifacts.json, surface to UI, emit artifact://
     *  URI. 'scratch' = do NOT register (file stays in scratch/{nodeId}/
     *  only); the tool result carries a `scratch:` path so the sub-agent
     *  can reference it in its prose, but it never becomes a user-visible
     *  artifact and is invisible to the Lead's <session-artifacts> block. */
    visibility: 'user' | 'scratch'
  },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (ctx.visibility === 'scratch') {
    // Research / verify sub-agents: report the file path in the tool result
    // so the sub-agent can talk about it in its prose, but keep it out of
    // the session artifact index. The `scratch:` scheme is deliberately
    // non-addressable by read_artifact / the UI artifact cards — scratch is
    // a private working surface, not a publish channel.
    for (const f of files) {
      out.push({
        filename: f.name,
        mime: f.mime,
        size: f.size,
        scratch_path: f.path,
        note: 'scratch file — internal working copy, not a user-visible artifact',
      })
    }
    return out
  }
  for (const f of files) {
    try {
      const rec = artifactsStore.recordArtifact({
        session_id: ctx.sessionId,
        team_id: ctx.teamId,
        company_slug: ctx.companySlug,
        team_slug: ctx.teamSlug,
        skill_name: ctx.skillName,
        filename: f.name,
        path: f.path,
        mime: f.mime,
        size: f.size,
        created_at_ms: Date.now(),
      })
      out.push({
        id: rec.id,
        filename: f.name,
        mime: f.mime,
        size: f.size,
        // A3: carry the canonical URI on the envelope so the LLM picks it
        // up immediately. Later microcompact passes + read_artifact calls
        // can then address the file without re-deriving the path.
        uri: buildArtifactUri(ctx.sessionId, f.path),
      })
    } catch (exc) {
      out.push({
        filename: f.name,
        register_error: exc instanceof Error ? exc.message : String(exc),
      })
    }
  }
  return out
}

// -------- simple async queue (replaces asyncio.Queue) --------

class AsyncQueue<T> {
  private buffer: T[] = []
  private waiters: Array<(value: T) => void> = []

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(value)
    else this.buffer.push(value)
  }

  pop(): Promise<T> {
    if (this.buffer.length > 0) return Promise.resolve(this.buffer.shift()!)
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}
