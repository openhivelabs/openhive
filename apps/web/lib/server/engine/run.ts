/**
 * Engine runner — async orchestrator.
 * Ports apps/server/openhive/engine/run.py (~1400 LOC).
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
import * as askuser from './askuser'
import * as errors from './errors'
import { getSettings } from '../config'
import { buildMessages, stream } from './providers'
import type { AgentSpec, TeamSpec } from './team'
import { entryAgent, subordinates as teamSubordinates } from './team'
import { makeEvent, type Event } from '../events/schema'
import * as artifactsStore from '../artifacts'
import * as teamDataStore from '../team-data'
import { recordUsage } from '../usage'
import {
  composePersonaBody,
  effectiveMcpServers,
  effectiveSkills,
  makePersonaTools,
  resolvePersona,
} from '../agents/runtime'
import {
  getSkill,
  type SkillDef,
} from '../skills/loader'
import {
  readSkillFile,
  runSkill,
  runSkillScript,
} from '../skills/runner'
import { toolsToOpenAI, type Tool } from '../tools/base'
import type { ChatMessage } from '../providers/types'

// Guard defaults + hard ceilings.
export const MAX_TOOL_ROUNDS = 8
export const MAX_DEPTH = 4
export const MAX_ASK_USER_PER_RUN = 3
export const HARD_MAX_TOOL_ROUNDS = 30
export const HARD_MAX_DEPTH = 8

// run_id → counters kept on globalThis so HMR doesn't drop in-flight runs.
interface RunState {
  askUser: Map<string, number>
  teamSlugs: Map<string, [string, string]>
  semaphore: Semaphore | null
}

const globalForRun = globalThis as unknown as {
  __openhive_engine_run?: RunState
}

function state(): RunState {
  if (!globalForRun.__openhive_engine_run) {
    globalForRun.__openhive_engine_run = {
      askUser: new Map(),
      teamSlugs: new Map(),
      semaphore: null,
    }
  }
  return globalForRun.__openhive_engine_run
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`
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

/** Thin indirection so tests / alternate deployments can swap in a different
 *  MCP backend without rewiring the engine. Default = real stdio manager. */
function mcpManager() {
  return mcpManagerImpl
}

// -------- top-level run_team generator --------

export interface RunTeamOpts {
  teamSlugs?: [string, string] | null
  locale?: string
}

export async function* runTeam(
  team: TeamSpec,
  goal: string,
  opts: RunTeamOpts = {},
): AsyncGenerator<Event> {
  const runId = newId('run')
  const sem = getRunSemaphore()

  const queued = sem.locked()
  if (queued) {
    const { inUse, total } = activeRunCapacity()
    yield makeEvent('run_queued', runId, { team_id: team.id, goal, in_use: inUse, limit: total })
  }
  await sem.acquire()

  try {
    state().askUser.set(runId, 0)
    if (opts.teamSlugs) state().teamSlugs.set(runId, opts.teamSlugs)

    // Wrap the entire run in the locale context so error formatter sees it.
    const iter = errors.withRunLocale(opts.locale ?? 'en', () =>
      runTeamBody(team, goal, runId),
    )
    for await (const ev of iter) yield ev
  } finally {
    state().askUser.delete(runId)
    state().teamSlugs.delete(runId)
    errors.clearRunFailures(runId)
    sem.release()
  }
}

async function* runTeamBody(
  team: TeamSpec,
  goal: string,
  runId: string,
): AsyncGenerator<Event> {
  yield makeEvent('run_started', runId, { team_id: team.id, goal })
  const entry = entryAgent(team)
  let final = ''
  try {
    for await (const ev of runNode({
      runId,
      team,
      node: entry,
      task: goal,
      depth: 0,
    })) {
      if (ev.kind === 'node_finished' && ev.depth === 0) {
        final = (ev.data.output as string | undefined) ?? ''
      }
      yield ev
    }
    yield makeEvent('run_finished', runId, { output: final })
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc)
    yield makeEvent('run_error', runId, { error: message })
  }
}

// -------- per-node driver --------

interface RunNodeOpts {
  runId: string
  team: TeamSpec
  node: AgentSpec
  task: string
  depth: number
}

async function* runNode(opts: RunNodeOpts): AsyncGenerator<Event> {
  const { runId, team, node, task, depth } = opts
  const teamSlugs = state().teamSlugs.get(runId) ?? null

  yield makeEvent(
    'node_started',
    runId,
    { role: node.role, task },
    { depth, node_id: node.id },
  )

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
  if (depth === 0) tools.push(askUserTool())
  if (teamSlugs) {
    tools.push(...teamDataTools(teamSlugs, true))
  }

  // Skills: typed get a structured tool; agent-format go through activate/read/run.
  const allowed = new Set(team.allowed_skills ?? [])
  const typedSkills: SkillDef[] = []
  const agentSkills: SkillDef[] = []
  for (const name of effectiveSkills(node, persona)) {
    if (!allowed.has(name)) continue
    const skill = getSkill(name)
    if (!skill) continue
    if (skill.kind === 'typed') typedSkills.push(skill)
    else agentSkills.push(skill)
  }
  for (const skill of typedSkills) {
    tools.push(skillTool(skill, { runId, team, teamSlugs }))
  }
  if (agentSkills.length > 0) {
    tools.push(skillActivateTool(agentSkills))
    tools.push(skillReadTool(agentSkills))
    tools.push(skillRunTool(agentSkills, { runId, team, teamSlugs }))
  }

  // MCP: per-server get_tools, wrap each as <server>__<tool>. A misconfigured
  // server surfaces a tool_result error but doesn't kill the run.
  const effectiveMcp = effectiveMcpServers(
    team.allowed_mcp_servers ?? [],
    persona,
  )
  for (const serverName of effectiveMcp) {
    let mcpTools: Record<string, unknown>[]
    try {
      mcpTools = await mcpManager().getTools(serverName)
    } catch (exc) {
      yield makeEvent(
        'tool_result',
        runId,
        {
          content: `MCP server '${serverName}' unavailable: ${exc instanceof Error ? exc.message : String(exc)}`,
          is_error: true,
        },
        { depth, node_id: node.id, tool_name: `${serverName}__init` },
      )
      continue
    }
    for (const t of mcpTools) tools.push(mcpTool(serverName, t))
  }

  // Progressive disclosure: system prompt only holds skill NAMES + one-line
  // descriptions. Bodies + file trees arrive via activate_skill once the LLM
  // picks one.
  const personaBody = composePersonaBody(persona)
  const systemPrompt = composeSystemPrompt(personaBody, agentSkills)
  tools.push(...makePersonaTools(persona))

  const history: ChatMessage[] = []
  history.push({ role: 'user', content: task })

  let rounds = 0
  while (true) {
    rounds += 1
    if (rounds > maxRounds) break

    let turnDone = false
    for await (const ev of streamTurn({
      runId,
      team,
      node,
      systemPrompt,
      history,
      tools,
      depth,
    })) {
      if (
        ev.kind === 'node_finished' &&
        ev.data._turn_marker === true
      ) {
        const stopReason = ev.data.stop_reason as string | undefined
        if (stopReason === 'tool_calls') {
          turnDone = true
          break
        }
        yield makeEvent(
          'node_finished',
          runId,
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
  runId: string
  team: TeamSpec
  node: AgentSpec
  systemPrompt: string
  history: ChatMessage[]
  tools: Tool[]
  depth: number
}

async function* streamTurn(opts: StreamTurnOpts): AsyncGenerator<Event> {
  const { runId, team, node, systemPrompt, history, tools, depth } = opts
  const messages = buildMessages(systemPrompt, history)
  const openaiTools = tools.length > 0 ? toolsToOpenAI(tools) : undefined

  const textBuf: string[] = []
  interface Pending {
    id: string | null
    name: string | null
    args: string
  }
  const pending = new Map<number, Pending>()
  let stopReason = 'stop'

  for await (const delta of stream(
    node.provider_id,
    node.model,
    messages,
    openaiTools,
  )) {
    if (delta.kind === 'text') {
      textBuf.push(delta.text)
      yield makeEvent(
        'token',
        runId,
        { text: delta.text },
        { depth, node_id: node.id },
      )
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
        const slugs = state().teamSlugs.get(runId) ?? null
        recordUsage({
          runId,
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

    for (const tc of toolCallsForHistory) {
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
        runId,
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
              runId,
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
              runId,
              team,
              fromNode: node,
              args: parsedArgs,
              toolCallId: tc.id,
              depth,
            })) {
              if (
                subEv.kind === 'delegation_closed' &&
                subEv.data.group_final
              ) {
                content = (subEv.data.result as string | undefined) ?? ''
                isError = !!subEv.data.error
              }
              yield subEv
            }
          } else if (tc.function.name === 'ask_user') {
            for await (const subEv of runAskUser({
              runId,
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
        runId,
        { content, is_error: isError },
        { depth, node_id: node.id, tool_call_id: tc.id, tool_name: tc.function.name },
      )
      history.push({
        role: 'tool',
        tool_call_id: tc.id,
        content,
      })
    }
  }

  yield makeEvent(
    'node_finished',
    runId,
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
          description:
            'Who should do the task. Must be one of your direct reports.',
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
  runId: string
  team: TeamSpec
  fromNode: AgentSpec
  args: Record<string, unknown>
  toolCallId: string
  depth: number
}

async function* runDelegation(opts: DelegationOpts): AsyncGenerator<Event> {
  const { runId, team, fromNode, args, toolCallId, depth } = opts
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
      runId,
      { error: true, result: `No such subordinate: ${assigneeKey}` },
      { depth, node_id: fromNode.id, tool_call_id: toolCallId },
    )
    return
  }

  if (errors.isAgentExcluded(runId, target.id)) {
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
      runId,
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
    runId,
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
      runId,
      team,
      node: target,
      task,
      depth: depth + 1,
    })) {
      if (
        ev.kind === 'node_finished' &&
        ev.depth === depth + 1 &&
        ev.node_id === target.id
      ) {
        subOutput = (ev.data.output as string | undefined) ?? ''
      }
      yield ev
    }
  } catch (exc) {
    errors.noteAgentFailure(runId, target.id)
    const classified = errors.classify(exc)
    const msg = errors.renderError(classified, {
      role: target.role,
      agentId: target.id,
      provider: target.provider_id,
      model: target.model,
    })
    yield makeEvent(
      'delegation_closed',
      runId,
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
    runId,
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
  const capsHint = eligible
    .map((s) => `${canonicalById[s.id]} ≤ ${s.max_parallel}`)
    .join(', ')
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

async function* runParallelDelegation(
  opts: DelegationOpts,
): AsyncGenerator<Event> {
  const { runId, team, fromNode, args, toolCallId, depth } = opts
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
      runId,
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
      runId,
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
      runId,
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
        runId,
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
      errors.noteAgentFailure(runId, capturedTarget.id)
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
    runId,
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
    runId,
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
  runId: string
  node: AgentSpec
  args: Record<string, unknown>
  toolCallId: string
  depth: number
}

async function* runAskUser(opts: AskUserOpts): AsyncGenerator<Event> {
  const { runId, node, args, toolCallId, depth } = opts
  const questions = Array.isArray(args.questions) ? args.questions : []

  const count = state().askUser.get(runId) ?? 0
  if (count >= MAX_ASK_USER_PER_RUN) {
    yield makeEvent(
      'user_answered',
      runId,
      {
        error: true,
        result: `ERROR: ask_user cap reached (${MAX_ASK_USER_PER_RUN} per run). Proceed with best-effort assumptions.`,
      },
      { depth, node_id: node.id, tool_call_id: toolCallId },
    )
    return
  }
  state().askUser.set(runId, count + 1)

  yield makeEvent(
    'user_question',
    runId,
    { questions, agent_role: node.role },
    { depth, node_id: node.id, tool_call_id: toolCallId },
  )

  let payload: Record<string, unknown>
  try {
    payload = await askuser.register(toolCallId)
  } catch {
    yield makeEvent(
      'user_answered',
      runId,
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
    runId,
    { result: resultText, skipped },
    { depth, node_id: node.id, tool_call_id: toolCallId },
  )
}

// -------- team-data tools --------

function teamDataTools(
  teamSlugs: [string, string],
  allowWrite: boolean,
): Tool[] {
  const [companySlug, teamSlug] = teamSlugs
  const tools: Tool[] = [
    {
      name: 'describe_schema',
      description:
        "List tables, columns, row counts, and recent schema migrations in this team's " +
        'data store. Always call this before writing SQL so you know what exists.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () =>
        JSON.stringify(teamDataStore.describeSchema(companySlug, teamSlug)),
      hint: 'Reading schema…',
    },
    {
      name: 'sql_query',
      description:
        "Run a read-only SQL query (SELECT or WITH) against this team's data store. " +
        'Returns {columns, rows}. Use to look up existing records before acting.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A SELECT/WITH statement.' },
        },
        required: ['sql'],
      },
      handler: async (args) =>
        JSON.stringify(
          teamDataStore.runQuery(companySlug, teamSlug, String(args.sql ?? '')),
        ),
      hint: 'Querying data…',
    },
  ]
  if (allowWrite) {
    tools.push({
      name: 'sql_exec',
      description:
        "Run a write query (INSERT/UPDATE/DELETE) or DDL (CREATE/ALTER) against this " +
        'team\'s data store. DDL is recorded in schema_migrations. Prefer ALTER over ' +
        'DROP; use the `data` JSON column for ad-hoc fields before adding new columns.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          note: { type: 'string', description: 'Why this change. Optional.' },
        },
        required: ['sql'],
      },
      handler: async (args) =>
        JSON.stringify(
          teamDataStore.runExec(companySlug, teamSlug, String(args.sql ?? ''), {
            source: 'ai',
            note: typeof args.note === 'string' ? args.note : null,
          }),
        ),
      hint: 'Writing data…',
    })
  }
  return tools
}

// -------- agent-skill plumbing (progressive disclosure) --------

function composeSystemPrompt(base: string, agentSkills: SkillDef[]): string {
  if (agentSkills.length === 0) return base
  const parts: string[] = []
  if (base) parts.push(base.trimEnd())
  parts.push('\n\n# Skills available to you\n')
  parts.push(
    'You have access to the skills listed below. For each, you only see the ' +
      'name and a one-line description right now. When a task looks like it ' +
      'matches one, call `activate_skill(name)` to load that skill\'s full guide ' +
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

function skillReadTool(agentSkills: SkillDef[]): Tool {
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
          description:
            "Path relative to the skill directory, e.g. 'references/FORMS.md'.",
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
      const { content, error } = readSkillFile(skill, path)
      if (error) return JSON.stringify({ ok: false, error })
      return JSON.stringify({ ok: true, path, content })
    },
    hint: 'Reading skill file…',
  }
}

interface SkillToolContext {
  runId: string
  team: TeamSpec
  teamSlugs: [string, string] | null
}

function skillRunTool(agentSkills: SkillDef[], ctx: SkillToolContext): Tool {
  const byName = new Map(agentSkills.map((s) => [s.name, s]))
  const names = [...byName.keys()].sort()
  const companySlug = ctx.teamSlugs ? ctx.teamSlugs[0] : null
  const teamSlug = ctx.teamSlugs ? ctx.teamSlugs[1] : null
  const outputDir = artifactsStore.artifactDirFor(companySlug, teamSlug, ctx.runId)

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
          description:
            "Path to the script relative to the skill dir, e.g. 'scripts/fill_form.py'.",
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
    handler: async (args) => {
      const skillName = String(args.skill ?? '')
      const script = String(args.script ?? '')
      const rawScriptArgs = args.args ?? []
      if (!Array.isArray(rawScriptArgs)) {
        return JSON.stringify({ ok: false, error: "'args' must be a list of strings" })
      }
      const scriptArgs = rawScriptArgs.map((a) => String(a))
      const stdinText = args.stdin
      if (stdinText !== undefined && typeof stdinText !== 'string') {
        return JSON.stringify({ ok: false, error: "'stdin' must be a string" })
      }

      const skill = byName.get(skillName)
      if (!skill) {
        return JSON.stringify({
          ok: false,
          error: `unknown or unauthorized skill: ${JSON.stringify(skillName)}`,
        })
      }

      const result = await runSkillScript(skill, script, outputDir, {
        args: scriptArgs,
        stdinText: typeof stdinText === 'string' ? stdinText : null,
      })
      const registered = registerSkillArtifacts(result.files, {
        runId: ctx.runId,
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
    hint: 'Running skill script…',
  }
}

// -------- typed skill tool --------

function skillTool(skill: SkillDef, ctx: SkillToolContext): Tool {
  const companySlug = ctx.teamSlugs ? ctx.teamSlugs[0] : null
  const teamSlug = ctx.teamSlugs ? ctx.teamSlugs[1] : null
  const outputDir = artifactsStore.artifactDirFor(companySlug, teamSlug, ctx.runId)

  return {
    name: skill.name,
    description: skill.description || `Run the ${skill.name} skill.`,
    parameters: skill.parameters ?? { type: 'object', properties: {} },
    handler: async (args) => {
      const result = await runSkill(skill, args, outputDir)
      const registered = registerSkillArtifacts(result.files, {
        runId: ctx.runId,
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
    hint: `Running ${skill.name}…`,
  }
}

// -------- MCP tool wrapper --------

function mcpTool(serverName: string, toolMeta: Record<string, unknown>): Tool {
  const toolName = typeof toolMeta.name === 'string' ? toolMeta.name : 'tool'
  const namespaced = `${serverName}__${toolName}`
  const description =
    typeof toolMeta.description === 'string' ? toolMeta.description.trim() : ''
  const parameters =
    toolMeta.inputSchema && typeof toolMeta.inputSchema === 'object'
      ? (toolMeta.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} }
  return {
    name: namespaced,
    description: description
      ? `[${serverName}] ${description}`
      : `[${serverName}]`,
    parameters,
    handler: async (args) => mcpManager().callTool(serverName, toolName, args),
    hint: `Calling ${serverName}…`,
  }
}

// -------- artifact helper --------

function registerSkillArtifacts(
  files: { name: string; path: string; mime: string; size: number }[],
  ctx: {
    runId: string
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
        run_id: ctx.runId,
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
