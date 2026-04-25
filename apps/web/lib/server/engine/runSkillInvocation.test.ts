/**
 * Tests for runSkillInvocation: heartbeat emission, abort handling, fast-skill
 * no-progress invariant. Uses real timers + a small heartbeat interval (via the
 * exported SKILL_PROGRESS_INTERVAL_MS constant being read at function entry —
 * but since it's evaluated each call, we can monkey-patch the module before
 * each test? No — it's `const` at import. Instead the tests use scenarios where
 * the heartbeat (5s default) either fires or doesn't relative to the skill's
 * resolution time, with generous timeouts. To keep wall-clock cheap we keep
 * the long-running skill bounded at ~12s using a fake AbortController-driven
 * resolver — no real 12s sleep.
 */

import { describe, expect, it } from 'vitest'
import type { Event } from '../events/schema'
import type { Tool } from '../tools/base'
import { runSkillInvocation, SKILL_PROGRESS_INTERVAL_MS } from './session'

function makeSkillTool(
  name: string,
  invoke: (
    args: Record<string, unknown>,
    hooks: { onQueued: () => void; onStarted: () => void },
    opts?: { signal?: AbortSignal },
  ) => Promise<unknown>,
): Tool {
  return {
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('handler should not be called for skill tools')
    },
    skill: {
      name,
      runWithHooks: invoke,
    },
  }
}

async function collect(
  gen: AsyncGenerator<Event>,
): Promise<Event[]> {
  const out: Event[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('runSkillInvocation', () => {
  it('fast skill emits no skill.progress, single tool_result', async () => {
    const tool = makeSkillTool('fast', async (_args, hooks) => {
      hooks.onQueued()
      hooks.onStarted()
      return 'OK'
    })
    const events = await collect(
      runSkillInvocation({
        sessionId: 's1',
        tool,
        args: {},
        toolCallId: 't1',
        toolName: 'fast',
        nodeId: 'n1',
        depth: 0,
      }),
    )
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('skill.queued')
    expect(kinds).toContain('skill.started')
    expect(kinds).not.toContain('skill.progress')
    const result = events.find((e) => e.kind === 'tool_result')
    expect(result).toBeDefined()
    expect(result?.data.content).toBe('OK')
    expect(result?.data.is_error).toBe(false)
  })

  it('emits skill.progress while a long-running skill is in flight', async () => {
    // Skill that runs for slightly longer than one heartbeat interval.
    const runtime = SKILL_PROGRESS_INTERVAL_MS + 200
    const tool = makeSkillTool('slow', async (_args, hooks) => {
      hooks.onQueued()
      hooks.onStarted()
      await new Promise((r) => setTimeout(r, runtime))
      return 'DONE'
    })
    const events = await collect(
      runSkillInvocation({
        sessionId: 's1',
        tool,
        args: {},
        toolCallId: 't1',
        toolName: 'slow',
        nodeId: 'n1',
        depth: 0,
      }),
    )
    const progress = events.filter((e) => e.kind === 'skill.progress')
    expect(progress.length).toBeGreaterThanOrEqual(1)
    for (const p of progress) {
      expect(typeof p.data.elapsed_ms).toBe('number')
      expect(p.data.skill).toBe('slow')
    }
    const result = events.find((e) => e.kind === 'tool_result')
    expect(result?.data.content).toBe('DONE')
    expect(result?.data.is_error).toBe(false)
    // tool_result is the LAST event yielded — invariant.
    expect(events[events.length - 1]?.kind).toBe('tool_result')
  }, 30_000)

  it('does NOT deadlock if runWithHooks returns without firing hooks', async () => {
    // Regression for the 2026-04-25 freeze: web-search cap-hit branch returned
    // a JSON error string without calling onQueued/onStarted, leaving
    // startedPromise unresolved and hanging the entire parallel sibling
    // (and by cascade, the whole session) forever.
    const tool = makeSkillTool('hookless', async () => {
      return JSON.stringify({ ok: false, error: 'cap reached' })
    })
    const events = await Promise.race([
      collect(
        runSkillInvocation({
          sessionId: 's1',
          tool,
          args: {},
          toolCallId: 't1',
          toolName: 'hookless',
          nodeId: 'n1',
          depth: 0,
        }),
      ),
      new Promise<Event[]>((_, reject) =>
        setTimeout(() => reject(new Error('runSkillInvocation deadlocked')), 2000),
      ),
    ])
    const result = events.find((e) => e.kind === 'tool_result')
    expect(result).toBeDefined()
    expect(result?.data.is_error).toBe(false)
    expect(result?.data.content as string).toContain('cap reached')
    expect(events[events.length - 1]?.kind).toBe('tool_result')
  })

  it('aborted mid-skill emits ABORTED tool_result with is_error=true', async () => {
    const controller = new AbortController()
    const tool = makeSkillTool('aborts', async (_args, hooks, opts) => {
      hooks.onQueued()
      hooks.onStarted()
      // Wait until aborted, then resolve with whatever the runner would have
      // returned (the override happens AFTER this resolves, in
      // runSkillInvocation, based on signal.aborted).
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) return resolve()
        opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return 'partial-output-that-should-be-overridden'
    })

    // Trigger abort shortly after start.
    setTimeout(() => controller.abort(), 50)

    const events = await collect(
      runSkillInvocation({
        sessionId: 's1',
        tool,
        args: {},
        toolCallId: 't1',
        toolName: 'aborts',
        nodeId: 'n1',
        depth: 0,
        signal: controller.signal,
      }),
    )
    const result = events.find((e) => e.kind === 'tool_result')
    expect(result).toBeDefined()
    expect(result?.data.is_error).toBe(true)
    expect(typeof result?.data.content).toBe('string')
    expect(result?.data.content as string).toMatch(/^ABORTED:/)
    expect(result?.data.content as string).toContain('aborts')
    // Last event MUST be tool_result so the LLM round can resolve.
    expect(events[events.length - 1]?.kind).toBe('tool_result')
  })
})
