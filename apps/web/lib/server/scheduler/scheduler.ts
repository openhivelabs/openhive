/**
 * Background cron loop.
 * Ports apps/server/openhive/scheduler/scheduler.py.
 *
 * - Wakes every settings.schedulerTickSeconds and scans tasks for scheduled
 *   entries. For each, decides whether its cron expression has fired since
 *   the last anchor (lastFiredAt or createdAt).
 * - If due, dispatches through the engine (same pat../api/sessions uses) and
 *   stamps lastFiredAt on completion.
 * - Panel bindings are refreshed in the same tick — declarative block data
 *   shouldn't wait for a task run.
 *
 * FIFO ordering: inherited from the engine's global semaphore. The scheduler
 * just fires and forgets; if N tasks fire at once and the semaphore is full,
 * they queue naturally.
 *
 * Singleton on globalThis so HMR doesn't spawn duplicate tickers.
 */

import { CronExpressionParser } from 'cron-parser'
import { getSettings } from '../config'
import { start as startRegistryRun } from '../engine/session-registry'
import { toTeamSpec, type TeamSpec } from '../engine/team'
import { listCompanies } from '../companies'
import { refreshDuePanels } from '../panels/refresher'
import { listTasks, saveTask } from '../tasks'

interface SchedulerState {
  inflight: Set<string>
  timer: NodeJS.Timeout | null
  running: boolean
}

const globalForScheduler = globalThis as unknown as {
  __openhive_scheduler?: SchedulerState
}

function state(): SchedulerState {
  if (!globalForScheduler.__openhive_scheduler) {
    globalForScheduler.__openhive_scheduler = {
      inflight: new Set(),
      timer: null,
      running: false,
    }
  }
  return globalForScheduler.__openhive_scheduler
}

function parseIso(v: unknown): Date | null {
  if (v instanceof Date) return v
  if (typeof v !== 'string' || !v) return null
  const d = new Date(v.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function composePrompt(task: Record<string, unknown>): string {
  const prompt = String(task.prompt ?? '')
  const refs = task.references
  if (!Array.isArray(refs) || refs.length === 0) return prompt
  const parts: string[] = [prompt, '', '--- Reference materials ---']
  for (const raw of refs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const ref = raw as Record<string, unknown>
    const name = typeof ref.name === 'string' ? ref.name : 'file'
    parts.push('')
    parts.push(`[file: ${name}]`)
    const note = String(ref.note ?? '').trim()
    if (note) parts.push(`note: ${note}`)
    if (ref.kind === 'text' && typeof ref.content === 'string') {
      parts.push(ref.content)
    } else {
      parts.push(`(binary, ${Number(ref.size ?? 0)} bytes — not inlined)`)
    }
  }
  return parts.join('\n')
}

function findTeam(
  teamId: string,
): { teamDict: Record<string, unknown>; companySlug: string; teamSlug: string } | null {
  for (const company of listCompanies()) {
    const companySlug = typeof company.slug === 'string' ? company.slug : null
    if (!companySlug) continue
    for (const team of company.teams ?? []) {
      if (team.id === teamId) {
        const teamSlug = typeof team.slug === 'string' ? team.slug : null
        if (!teamSlug) continue
        return {
          teamDict: team as Record<string, unknown>,
          companySlug,
          teamSlug,
        }
      }
    }
  }
  return null
}

/** Accept camelCase (web writes) and snake_case (YAML) interchangeably. */
function normaliseTeamShape(raw: Record<string, unknown>): Record<string, unknown> {
  const agents = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : []
  const normalisedAgents = agents.map((a) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return a
    const ag = a as Record<string, unknown>
    return {
      ...ag,
      provider_id: ag.provider_id ?? ag.providerId,
      system_prompt: ag.system_prompt ?? ag.systemPrompt,
      max_parallel: ag.max_parallel ?? ag.maxParallel ?? 1,
      persona_path: ag.persona_path ?? ag.personaPath,
      persona_name: ag.persona_name ?? ag.personaName,
    }
  })
  return {
    ...raw,
    agents: normalisedAgents,
    entry_agent_id: raw.entry_agent_id ?? raw.entryAgentId,
    allowed_skills: raw.allowed_skills ?? raw.allowedSkills ?? [],
    allowed_mcp_servers: raw.allowed_mcp_servers ?? raw.allowedMcpServers ?? [],
    limits: raw.limits ?? {
      max_tool_rounds_per_turn: 8,
      max_delegation_depth: 4,
    },
  }
}

function buildTeamSpec(teamDict: Record<string, unknown>): TeamSpec {
  return toTeamSpec(normaliseTeamShape(teamDict))
}

async function fire(task: Record<string, unknown>): Promise<void> {
  const taskId = String(task.id ?? '')
  const teamId = String(task.teamId ?? '')
  const resolved = findTeam(teamId)
  if (!resolved) {
    console.warn(
      `scheduler: team ${teamId} not found for task ${taskId}`,
    )
    return
  }

  let teamSpec: TeamSpec
  try {
    teamSpec = buildTeamSpec(resolved.teamDict)
  } catch (exc) {
    console.error(
      `scheduler: failed to build TeamSpec for task ${taskId}`,
      exc,
    )
    return
  }

  const prompt = composePrompt(task)
  // Delegate through the shared registry entry point instead of driving the
  // engine loop ourselves. This gives scheduled runs everything interactive
  // runs get: auto-title generation, team_snapshot persistence for resume,
  // turn_finished → idle status flips, and consistent event-writer batching.
  try {
    await startRegistryRun(
      teamSpec,
      prompt,
      [resolved.companySlug, resolved.teamSlug],
      'en',
      taskId || null,
    )
  } catch (exc) {
    console.error(`scheduler: runTeam raised for task ${taskId}`, exc)
  }

  // Stamp lastFiredAt so the next tick uses it as the cron anchor.
  try {
    const fresh = listTasks().find((t) => t.id === taskId)
    if (fresh) {
      fresh.lastFiredAt = new Date().toISOString()
      saveTask(taskId, fresh)
    }
  } catch (exc) {
    console.error(
      `scheduler: failed to stamp lastFiredAt for ${taskId}`,
      exc,
    )
  }
}

async function tick(): Promise<void> {
  try {
    await refreshDuePanels()
  } catch (exc) {
    console.error('scheduler: panel refresh pass failed', exc)
  }

  let tasks: Record<string, unknown>[]
  try {
    tasks = listTasks()
  } catch (exc) {
    console.error('scheduler: listTasks failed', exc)
    return
  }
  const now = new Date()
  const s = state()
  for (const task of tasks) {
    const taskId = String(task.id ?? '')
    if (!taskId || s.inflight.has(taskId)) continue
    if (task.mode !== 'scheduled') continue
    const cronExpr = task.cron
    if (typeof cronExpr !== 'string' || !cronExpr) continue
    const anchor =
      parseIso(task.lastFiredAt) ?? parseIso(task.createdAt) ?? now
    let nextFire: Date
    try {
      const itr = CronExpressionParser.parse(cronExpr, {
        currentDate: anchor,
        tz: 'UTC',
      })
      nextFire = itr.next().toDate()
    } catch {
      console.warn(`scheduler: bad cron ${JSON.stringify(cronExpr)} on task ${taskId}`)
      continue
    }
    if (nextFire <= now) {
      s.inflight.add(taskId)
      void (async () => {
        try {
          await fire(task)
        } finally {
          s.inflight.delete(taskId)
        }
      })()
    }
  }
}

function scheduleNext(): void {
  const s = state()
  if (!s.running) return
  const intervalMs = Math.max(1, getSettings().schedulerTickSeconds) * 1000
  s.timer = setTimeout(async () => {
    try {
      await tick()
    } catch (exc) {
      console.error('scheduler tick failed', exc)
    }
    scheduleNext()
  }, intervalMs)
}

export function startScheduler(): void {
  const s = state()
  if (s.running) return
  s.running = true
  console.log(
    `scheduler started — tick=${getSettings().schedulerTickSeconds}s`,
  )
  scheduleNext()
}

export function stopScheduler(): void {
  const s = state()
  s.running = false
  if (s.timer) {
    clearTimeout(s.timer)
    s.timer = null
  }
}
