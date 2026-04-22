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
import type { ChatMessage } from '../providers/types'
import * as sessionsStore from '../sessions'
import { type SkillDef, getSkill, matchSkillHints } from '../skills/loader'
import { readSkillFile, runSkill, runSkillScript } from '../skills/runner'
import { type Tool, toolsToOpenAI } from '../tools/base'
import { teamDataTools } from '../tools/team-data-tool'
import { webFetchTool } from '../tools/webfetch'
import { recordUsage } from '../usage'
import * as askuser from './askuser'
import * as errors from './errors'
import { stream, buildMessages } from './providers'
import type { AgentSpec, TeamSpec } from './team'
import { entryAgent, subordinates as teamSubordinates } from './team'

// Guard defaults + hard ceilings.
export const MAX_TOOL_ROUNDS = 8
export const MAX_DEPTH = 4
export const MAX_ASK_USER_PER_RUN = 3
export const HARD_MAX_TOOL_ROUNDS = 30
export const HARD_MAX_DEPTH = 8

/** Tool names that mutate run-scoped state (delegation tree, ask_user
 *  counter, todos) — these must execute serially. Every other tool (MCP,
 *  skill helpers, custom handlers) is parallel-safe in a single turn. */
export const SERIAL_TOOL_NAMES = new Set<string>([
  'delegate_to',
  'delegate_parallel',
  'ask_user',
  'set_todos',
  'add_todo',
  'complete_todo',
])

/** Partition tool_calls into consecutive serial/parallel runs. Adjacent
 *  same-kind calls collapse into one run; the order inside each run is
 *  preserved so provider history remains deterministic. */
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
  // sessionId → ordered todo list maintained by the Lead via native tools.
  todos: Map<string, TodoItem[]>
}

// Phase C1: Cap per-(parent→child) delegations within a run. A parent re-
// delegating the same sub-agent 3+ times almost always means "REVISED TASK"
// spam — the parent should accept the result or fix it itself.
export const MAX_DELEGATIONS_PER_PAIR = 2

// Phase C3: Cap read_skill_file. Once a skill is activated the LLM tends to
// spelunk its entire tree looking for answers it already has. Same-file reads
// are always redundant; total cap stops fan-out sprees mid-turn.
export const MAX_READ_SKILL_FILE_PER_RUN = 8

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
      todos: new Map(),
    }
  }
  // HMR-safe: if an older incarnation initialised the global without a newer
  // field, backfill it instead of crashing with "undefined.get".
  const s = globalForRun.__openhive_engine_run
  if (!s.delegations) s.delegations = new Map()
  if (!s.readSkillFileTotal) s.readSkillFileTotal = new Map()
  if (!s.readSkillFileSeen) s.readSkillFileSeen = new Map()
  if (!s.todos) s.todos = new Map()
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

class Semaphore {
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
  await sem.acquire()

  try {
    state().askUser.set(sessionId, 0)
    if (opts.teamSlugs) state().teamSlugs.set(sessionId, opts.teamSlugs)

    // Wrap the entire run in the locale context so error formatter sees it.
    const iter = errors.withRunLocale(opts.locale ?? 'en', () =>
      runTeamBody(team, goal, sessionId, opts.resume?.history),
    )
    for await (const ev of iter) yield ev
  } finally {
    state().askUser.delete(sessionId)
    state().teamSlugs.delete(sessionId)
    for (const k of state().delegations.keys()) {
      if (k.startsWith(`${sessionId}:`)) state().delegations.delete(k)
    }
    state().readSkillFileTotal.delete(sessionId)
    state().readSkillFileSeen.delete(sessionId)
    state().todos.delete(sessionId)
    errors.clearSessionFailures(sessionId)
    sem.release()
  }
}

async function* runTeamBody(
  team: TeamSpec,
  goal: string,
  sessionId: string,
  resumeHistory?: ChatMessage[],
): AsyncGenerator<Event> {
  const isResume = !!resumeHistory
  if (isResume) {
    // Session already exists on disk. `goal` is the new user message — emit
    // it as user_message so the stream looks identical to a live follow-up.
    yield makeEvent('user_message', sessionId, { text: goal })
  } else {
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
  try {
    while (true) {
      for await (const ev of runNode({
        sessionId,
        team,
        node: entry,
        task: currentTask,
        depth: 0,
        externalHistory: leadHistory,
      })) {
        if (ev.kind === 'node_finished' && ev.depth === 0) {
          lastFinal = (ev.data.output as string | undefined) ?? ''
        }
        yield ev
      }
      // Lead finished a turn — park until the user sends another message.
      yield makeEvent('turn_finished', sessionId, { output: lastFinal })
      const next = await inbox.pop()
      // null = session being torn down.
      if (next === null) break
      yield makeEvent('user_message', sessionId, { text: next })
      currentTask = next
    }
    yield makeEvent('run_finished', sessionId, { output: lastFinal })
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc)
    yield makeEvent('run_error', sessionId, { error: message })
  } finally {
    inboxState().queues.delete(sessionId)
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
}

async function* runNode(opts: SessionNodeOpts): AsyncGenerator<Event> {
  const { sessionId, team, node, task, depth, externalHistory } = opts
  const teamSlugs = state().teamSlugs.get(sessionId) ?? null

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
  }
  if (teamSlugs) {
    tools.push(...teamDataTools(teamSlugs, persona.tools))
  }
  tools.push(webFetchTool())

  // Skills: typed get a structured tool; agent-format go through activate/read/run.
  // team.allowed_skills is an OPTIONAL whitelist. If it's undefined or empty,
  // trust the agent's own declared skills — a fresh team shouldn't have to
  // re-declare every skill at the team level just to make its own agents work.
  // Only filter when the team explicitly narrowed the set.
  const rawAllowed = team.allowed_skills ?? []
  const hasAllowlist = rawAllowed.length > 0
  const allowed = new Set(rawAllowed)
  const typedSkills: SkillDef[] = []
  const agentSkills: SkillDef[] = []
  for (const name of effectiveSkills(node, persona)) {
    if (hasAllowlist && !allowed.has(name)) continue
    const skill = getSkill(name)
    if (!skill) continue
    if (skill.kind === 'typed') typedSkills.push(skill)
    else agentSkills.push(skill)
  }
  for (const skill of typedSkills) {
    tools.push(skillTool(skill, { sessionId, team, teamSlugs }))
  }
  if (agentSkills.length > 0) {
    tools.push(skillActivateTool(agentSkills))
    tools.push(skillReadTool(agentSkills, sessionId))
    tools.push(skillRunTool(agentSkills, { sessionId, team, teamSlugs }))
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
  const relaySection = buildRelaySection(depth, hasSubs)
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
    const prefix = (todosBlock ? todosBlock + '\n' : '') + (showHints ? hintsBlock + '\n' : '')
    const teamBlock = prefix ? prefix + staticTeamBlock : staticTeamBlock
    return composeSystemPrompt(personaBody, agentSkills, teamBlock)
  }
  tools.push(...makePersonaTools(persona))

  const history: ChatMessage[] = externalHistory ?? []
  history.push({ role: 'user', content: task })

  // History sliding-window: Infinity keeps the feature inert by default so
  // existing sessions see byte-identical prompts. Nodes can opt in later by
  // surfacing a finite window via persona config.
  const historyWindow = Number.POSITIVE_INFINITY
  const summariseHistory = async (_msgs: ChatMessage[]): Promise<string> => ''

  let rounds = 0
  while (true) {
    rounds += 1
    if (rounds > maxRounds) break

    // Only pays when the node has opted into a finite window.
    if (Number.isFinite(historyWindow)) {
      const next = await compactHistory(history, historyWindow, summariseHistory)
      if (next !== history) {
        history.length = 0
        history.push(...next)
      }
    }

    let turnDone = false
    for await (const ev of streamTurn({
      sessionId,
      team,
      node,
      systemPrompt: buildSystemPrompt(rounds),
      history,
      tools,
      depth,
    })) {
      if (ev.kind === 'node_finished' && ev.data._turn_marker === true) {
        const stopReason = ev.data.stop_reason as string | undefined
        if (stopReason === 'tool_calls') {
          turnDone = true
          break
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

// -------- provider turn --------

interface StreamTurnOpts {
  sessionId: string
  team: TeamSpec
  node: AgentSpec
  systemPrompt: string
  history: ChatMessage[]
  tools: Tool[]
  depth: number
}

async function* streamTurn(opts: StreamTurnOpts): AsyncGenerator<Event> {
  const { sessionId, team, node, systemPrompt, history, tools, depth } = opts
  const messages = buildMessages(systemPrompt, history)
  const openaiTools = tools.length > 0 ? toolsToOpenAI(tools) : undefined

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

  const textBuf: string[] = []
  interface Pending {
    id: string | null
    name: string | null
    args: string
  }
  const pending = new Map<number, Pending>()
  let stopReason = 'stop'

  for await (const delta of stream(node.provider_id, node.model, messages, openaiTools)) {
    if (delta.kind === 'text') {
      textBuf.push(delta.text)
      yield makeEvent('token', sessionId, { text: delta.text }, { depth, node_id: node.id })
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
    })

    // Split tool_calls into serial-vs-parallel runs. Tools that mutate
    // run-scoped state (delegation, ask_user, todo) stay serial; everything
    // else (MCP, skills, custom) runs concurrently. History is always pushed
    // in original tool_call order so provider payloads stay deterministic.
    type ExecResult = { content: string; isError: boolean }
    type TC = (typeof toolCallsForHistory)[number]
    const runs = splitToolRuns<TC>(toolCallsForHistory)

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
                content = (subEv.data.result as string | undefined) ?? ''
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
                content = (subEv.data.result as string | undefined) ?? ''
                isError = !!subEv.data.error
              }
              yield subEv
            }
          } else if (tc.function.name === 'ask_user') {
            for await (const subEv of runAskUser({
              sessionId,
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
      if (run.serial || run.items.length === 1) {
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
        // Parallel: kick off every tc concurrently; interleave their events
        // via AsyncQueue so the caller sees them as they arrive. Results are
        // collected into a slot array so history.push remains in index order.
        const n = run.items.length
        type Item =
          | { kind: 'event'; event: Event }
          | { kind: 'done'; index: number; result: ExecResult }
        const queue = new AsyncQueue<Item>()
        const results: Array<ExecResult | null> = new Array(n).fill(null)

        for (let i = 0; i < n; i++) {
          const tc = run.items[i]!
          const idx = i
          void (async () => {
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
          })()
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

// -------- delegation --------

function delegateTool(team: TeamSpec, node: AgentSpec): Tool {
  const subs = teamSubordinates(team, node.id)
  const roleCounts: Record<string, number> = {}
  for (const s of subs) roleCounts[s.role] = (roleCounts[s.role] ?? 0) + 1
  const seen: Record<string, number> = {}
  const canonical: string[] = []
  for (const s of subs) {
    seen[s.role] = (seen[s.role] ?? 0) + 1
    const dup = (roleCounts[s.role] ?? 0) > 1
    canonical.push(dup ? `${s.role}#${s.id}` : s.role)
  }
  return {
    name: 'delegate_to',
    description:
      'Assign a task to a direct subordinate. Use this whenever the work requires ' +
      'specialist attention. The subordinate will respond with their output.',
    parameters: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          enum: canonical,
          description: 'Who should do the task. Must be one of your direct reports.',
        },
        task: {
          type: 'string',
          description: 'Clear instructions for the subordinate. Include context.',
        },
      },
      required: ['assignee', 'task'],
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
  const prior = state().delegations.get(pairKey) ?? 0
  if (prior >= MAX_DELEGATIONS_PER_PAIR) {
    yield makeEvent(
      'delegation_closed',
      sessionId,
      {
        assignee_id: target.id,
        assignee_role: target.role,
        error: true,
        result:
          `ERROR: delegation cap reached (${MAX_DELEGATIONS_PER_PAIR} calls to ${target.role} ` +
          `from this agent in this run). Do NOT re-delegate the same subtask. Accept the ` +
          `prior result or fix remaining issues yourself, then end your turn.`,
      },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }
  state().delegations.set(pairKey, prior + 1)

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
  try {
    for await (const ev of runNode({
      sessionId,
      team,
      node: target,
      task,
      depth: depth + 1,
    })) {
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

  yield makeEvent(
    'delegation_closed',
    sessionId,
    {
      assignee_id: target.id,
      assignee_role: target.role,
      result: subOutput,
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
      },
      required: ['assignee', 'tasks'],
    },
    handler: async () => 'delegate_parallel handled by engine',
    hint: 'Fanning out…',
  }
}

async function* runParallelDelegation(opts: DelegationOpts): AsyncGenerator<Event> {
  const { sessionId, team, fromNode, args, toolCallId, depth } = opts
  const assigneeKey = String(args.assignee ?? '')
  const tasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : []

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

  const runOne = async (i: number, taskText: string): Promise<void> => {
    try {
      for await (const ev of runNode({
        sessionId,
        team,
        node: capturedTarget,
        task: taskText,
        depth: depth + 1,
      })) {
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
    description:
      'Ask the human user clarifying questions before proceeding. Use this when ' +
      'requirements are ambiguous and an answer would materially change the plan. ' +
      "Each question must have 2-4 concrete options; the UI adds 'Other' and 'Skip' automatically. " +
      "If recommending, put the recommendation first and suffix its label with ' (Recommended)'.",
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
  node: AgentSpec
  args: Record<string, unknown>
  toolCallId: string
  depth: number
}

async function* runAskUser(opts: AskUserOpts): AsyncGenerator<Event> {
  const { sessionId, node, args, toolCallId, depth } = opts
  const questions = Array.isArray(args.questions) ? args.questions : []

  const count = state().askUser.get(sessionId) ?? 0
  if (count >= MAX_ASK_USER_PER_RUN) {
    yield makeEvent(
      'user_answered',
      sessionId,
      {
        error: true,
        result: `ERROR: ask_user cap reached (${MAX_ASK_USER_PER_RUN} per run). Proceed with best-effort assumptions.`,
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

// Shared sentinel. Sub-agents who need user clarification prefix their entire
// message with it; managers re-emit it verbatim upward; Lead is instructed to
// detect it and fire `ask_user`. One token, easy to grep for, and the LLM
// treats prefix sentinels consistently across vendors.
const CLARIFY_SENTINEL = 'CLARIFICATION_REQUEST:'

function buildRelaySection(depth: number, hasSubs: boolean): string {
  if (depth === 0) {
    return (
      '# User gateway (you only)\n' +
      'Any ask for user input — yours or relayed ' +
      `\`${CLARIFY_SENTINEL}\` from a delegate — MUST use the \`ask_user\` tool. ` +
      'Never end a turn with plain text requesting something ("링크 주세요" etc.) — ' +
      'that finalises the run. Never guess a default or re-delegate with an ' +
      'assumption while a clarification is pending. Consolidate pending items ' +
      'into ONE ask_user call.\n' +
      '\n# One-shot delegation (hard rule)\n' +
      `You may call \`delegate_to\` on each subordinate at most ${MAX_DELEGATIONS_PER_PAIR} times per run ` +
      '(the engine enforces this). When a delegate returns a usable result, ' +
      'do NOT re-delegate with "REVISED TASK" or "please polish X" — either ' +
      'accept the result and finish, or edit/annotate it yourself in your ' +
      'final answer. Picking at the same deliverable with more rounds of the ' +
      'same delegate burns tokens without improving quality.\n' +
      '\n# Final message = report, not a chat (hard rule)\n' +
      'Your final turn ends the run. Write it as a terminal report: deliver ' +
      'the result (artifact path, summary, process trace) and stop. **Never ' +
      'offer revision options, menus, or "다음 단계" / "원하시면" / "어떻게 ' +
      '할까요?" trailers.** No "(1) 문구 수정 … (2) 링크 제공 … (3) 재발행 …" ' +
      'style prompts. No questions inviting follow-up. The user can start a ' +
      'new task if they want revisions; your job is to finish cleanly.\n'
    )
  }
  let section =
    '# User contact\n' +
    'Only the Lead can talk to the user. If you need input, end your turn with ' +
    `a message whose first line is exactly:\n  ${CLARIFY_SENTINEL} <question>\n` +
    'then 2–4 option lines: `- <label>: <description>`. No other content. ' +
    'Parent relays upstream.\n'
  if (hasSubs) {
    section +=
      '\n# Relaying from delegates\n' +
      `If a delegate tool_result starts with \`${CLARIFY_SENTINEL}\`, forward ` +
      'verbatim as your own next output. Do NOT answer it, pick defaults, or ' +
      're-delegate with an assumption. Only the Lead surfaces to the user.\n'
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
    parts.push(`- \`${skill.name}\` — ${desc}\n`)
  }
  return parts.join('')
}

function skillActivateTool(agentSkills: SkillDef[]): Tool {
  const byName = new Map(agentSkills.map((s) => [s.name, s]))
  const names = [...byName.keys()].sort()
  return {
    name: 'activate_skill',
    description:
      "Load a skill's full guide (SKILL.md body + list of files in its " +
      'directory) into this conversation. Call this once per skill you ' +
      'intend to use, before reading its files or running its scripts.',
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
        files: skill.fileTree ?? [],
        hint:
          'Read SKILL.md guide above. Use read_skill_file(skill, path) for ' +
          'any referenced docs and run_skill_script(skill, script, ...) to ' +
          'execute. Paths are relative to the skill directory.',
      })
    },
    hint: 'Activating skill…',
  }
}

function skillReadTool(agentSkills: SkillDef[], sessionId: string): Tool {
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
      if (total >= MAX_READ_SKILL_FILE_PER_RUN) {
        return JSON.stringify({
          ok: false,
          error:
            `read_skill_file cap reached (${MAX_READ_SKILL_FILE_PER_RUN} per run). ` +
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
}

function skillRunTool(agentSkills: SkillDef[], ctx: SkillToolContext): Tool {
  const byName = new Map(agentSkills.map((s) => [s.name, s]))
  const names = [...byName.keys()].sort()
  const companySlug = ctx.teamSlugs ? ctx.teamSlugs[0] : null
  const teamSlug = ctx.teamSlugs ? ctx.teamSlugs[1] : null
  const outputDir = sessionsStore.artifactDirForSession(ctx.sessionId)

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
  const outputDir = sessionsStore.artifactDirForSession(ctx.sessionId)

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
        const result = await runSkill(skill, args, outputDir, { hooks })
        const registered = registerSkillArtifacts(result.files, {
          sessionId: ctx.sessionId,
          teamId: ctx.team.id,
          companySlug,
          teamSlug,
          skillName: skill.name,
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
  },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
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
