/**
 * Unit tests for S2 microcompact — cases A through I from spec §Task 3.2.
 *
 * Time-based trigger, whitelist tool set, run_skill_script envelope
 * preservation, idempotency, and legacy (no-_ts) handling.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../providers/types'
import { STALE_AFTER_MS, isCompactable, maybeMicrocompact } from './microcompact'

const SESSION = 'sess-test'

/** Build a minimal 2-message fragment: one assistant turn calling one tool,
 *  plus the tool's result. The assistant's `_ts` determines "last turn"
 *  age. */
function mkPair(opts: {
  toolName: string
  toolCallId: string
  result: string
  assistantTs?: number
  toolTs?: number
}): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: opts.toolCallId,
          type: 'function',
          function: { name: opts.toolName, arguments: '{}' },
        },
      ],
      _ts: opts.assistantTs,
    },
    {
      role: 'tool',
      tool_call_id: opts.toolCallId,
      content: opts.result,
      _ts: opts.toolTs,
    },
  ]
}

const LONG_BODY = 'x'.repeat(5_000)

describe('isCompactable', () => {
  it('clears built-ins', () => {
    expect(isCompactable('web_fetch')).toBe(true)
    expect(isCompactable('sql_query')).toBe(true)
    expect(isCompactable('read_skill_file')).toBe(true)
    expect(isCompactable('run_skill_script')).toBe(true)
  })
  it('preserves trajectory tools', () => {
    expect(isCompactable('delegate_to')).toBe(false)
    expect(isCompactable('delegate_parallel')).toBe(false)
    expect(isCompactable('ask_user')).toBe(false)
    expect(isCompactable('set_todos')).toBe(false)
    expect(isCompactable('sql_exec')).toBe(false)
    expect(isCompactable('activate_skill')).toBe(false)
  })
  it('treats mcp__* as compactable', () => {
    expect(isCompactable('mcp__notion__notion-search')).toBe(true)
    expect(isCompactable('mcp__slack__list-channels')).toBe(true)
  })
  it('leaves unknown tools alone', () => {
    expect(isCompactable('random_custom_tool')).toBe(false)
  })
})

describe('maybeMicrocompact', () => {
  // -------- Case A: stale web_fetch is cleared --------
  it('A: clears stale web_fetch result with placeholder', () => {
    const now = 10_000_000
    const history = mkPair({
      toolName: 'web_fetch',
      toolCallId: 'c1',
      result: LONG_BODY,
      assistantTs: now - (STALE_AFTER_MS + 60_000), // 6 min ago
    })
    const res = maybeMicrocompact(history, SESSION, now)
    expect(res.applied).toBe(1)
    expect(res.charsSaved).toBeGreaterThan(0)
    expect(history[1].content).toContain('[Old tool result cleared')
    expect(history[1].content).toContain('Tool: web_fetch')
  })

  // -------- Case B: hot cache — no-op --------
  it('B: within STALE_AFTER_MS — no-op', () => {
    const now = 10_000_000
    const history = mkPair({
      toolName: 'web_fetch',
      toolCallId: 'c1',
      result: LONG_BODY,
      assistantTs: now - 60_000, // 1 min ago
    })
    const res = maybeMicrocompact(history, SESSION, now)
    expect(res.applied).toBe(0)
    expect(history[1].content).toBe(LONG_BODY)
  })

  // -------- Case C: delegate_to is preserved --------
  it('C: delegate_to is NEVER_COMPACT', () => {
    const now = 10_000_000
    const history = mkPair({
      toolName: 'delegate_to',
      toolCallId: 'c1',
      result: LONG_BODY,
      assistantTs: now - (STALE_AFTER_MS + 60_000),
    })
    const res = maybeMicrocompact(history, SESSION, now)
    expect(res.applied).toBe(0)
    expect(history[1].content).toBe(LONG_BODY)
  })

  // -------- Case D: mcp__* is auto-compactable --------
  it('D: mcp__notion__notion-search is cleared when stale', () => {
    const now = 10_000_000
    const history = mkPair({
      toolName: 'mcp__notion__notion-search',
      toolCallId: 'c1',
      result: LONG_BODY,
      assistantTs: now - (STALE_AFTER_MS + 60_000),
    })
    const res = maybeMicrocompact(history, SESSION, now)
    expect(res.applied).toBe(1)
    expect(history[1].content).toContain('[Old tool result cleared')
    expect(history[1].content).toContain('Tool: mcp__notion__notion-search')
  })

  // -------- Case E: run_skill_script preserves files[] --------
  it('E: run_skill_script preserves files[] and clears stdout/stderr', () => {
    const now = 10_000_000
    const envelope = JSON.stringify({
      ok: true,
      stdout: 'a'.repeat(3000),
      stderr: 'b'.repeat(3000),
      files: [{ name: 'a.csv', path: '/tmp/a.csv' }],
    })
    const history = mkPair({
      toolName: 'run_skill_script',
      toolCallId: 'c1',
      result: envelope,
      assistantTs: now - (STALE_AFTER_MS + 60_000),
    })
    const res = maybeMicrocompact(history, SESSION, now)
    expect(res.applied).toBe(1)
    const content = history[1].content as string
    const parsed = JSON.parse(content)
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0].name).toBe('a.csv')
    expect(parsed._cleared).toContain('stdout/stderr cleared')
    expect(parsed.stdout).toBeUndefined()
    expect(parsed.stderr).toBeUndefined()
  })

  // -------- Case F: DISABLED kill switch --------
  it('F: OPENHIVE_MICROCOMPACT_DISABLED forces applied=0', async () => {
    // Env is captured at module load, so reset the module cache and
    // re-import with the kill-switch set.
    const prev = process.env.OPENHIVE_MICROCOMPACT_DISABLED
    process.env.OPENHIVE_MICROCOMPACT_DISABLED = '1'
    vi.resetModules()
    try {
      const mod = await import('./microcompact')
      const now = 10_000_000
      const history = mkPair({
        toolName: 'web_fetch',
        toolCallId: 'c1',
        result: LONG_BODY,
        assistantTs: now - (mod.STALE_AFTER_MS + 60_000),
      })
      const res = mod.maybeMicrocompact(history, SESSION, now)
      expect(res.applied).toBe(0)
      expect(history[1].content).toBe(LONG_BODY)
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'OPENHIVE_MICROCOMPACT_DISABLED')
      else process.env.OPENHIVE_MICROCOMPACT_DISABLED = prev
      vi.resetModules()
    }
  })

  // -------- Case G: idempotent --------
  it('G: second pass is a no-op (already cleared)', () => {
    const now = 10_000_000
    const history = mkPair({
      toolName: 'web_fetch',
      toolCallId: 'c1',
      result: LONG_BODY,
      assistantTs: now - (STALE_AFTER_MS + 60_000),
    })
    const first = maybeMicrocompact(history, SESSION, now)
    expect(first.applied).toBe(1)
    const second = maybeMicrocompact(history, SESSION, now)
    expect(second.applied).toBe(0)
  })

  // -------- Case H: legacy history (no _ts) — lastTs=0, treated as stale --------
  it('H: legacy history with no _ts compacts all compactable entries', () => {
    const now = 10_000_000
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'web_fetch', arguments: '{}' },
          },
          {
            id: 'c2',
            type: 'function',
            function: { name: 'sql_query', arguments: '{}' },
          },
        ],
        // no _ts — reattach simulation
      },
      { role: 'tool', tool_call_id: 'c1', content: LONG_BODY },
      { role: 'tool', tool_call_id: 'c2', content: LONG_BODY },
    ]
    const res = maybeMicrocompact(history, SESSION, now)
    expect(res.applied).toBe(2)
    expect(history[1].content).toContain('[Old tool result cleared')
    expect(history[2].content).toContain('[Old tool result cleared')
  })

  // -------- Case I: sql_exec preserved, sql_query cleared --------
  it('I: sql_exec preserved, sql_query cleared', () => {
    const now = 10_000_000
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'q1',
            type: 'function',
            function: { name: 'sql_query', arguments: '{}' },
          },
          {
            id: 'e1',
            type: 'function',
            function: { name: 'sql_exec', arguments: '{}' },
          },
        ],
        _ts: now - (STALE_AFTER_MS + 60_000),
      },
      { role: 'tool', tool_call_id: 'q1', content: LONG_BODY },
      { role: 'tool', tool_call_id: 'e1', content: LONG_BODY },
    ]
    const res = maybeMicrocompact(history, SESSION, now)
    expect(res.applied).toBe(1)
    expect(history[1].content).toContain('[Old tool result cleared')
    expect(history[2].content).toBe(LONG_BODY)
  })

  // -------- Extra guards --------
  it('skips short content below MICROCOMPACT_MIN_CHARS', () => {
    const now = 10_000_000
    const history = mkPair({
      toolName: 'web_fetch',
      toolCallId: 'c1',
      result: 'tiny',
      assistantTs: now - (STALE_AFTER_MS + 60_000),
    })
    const res = maybeMicrocompact(history, SESSION, now)
    expect(res.applied).toBe(0)
    expect(history[1].content).toBe('tiny')
  })

  it('empty history returns no-op', () => {
    const res = maybeMicrocompact([], SESSION, Date.now())
    expect(res.applied).toBe(0)
    expect(res.entries).toHaveLength(0)
  })
})
