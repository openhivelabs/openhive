import { describe, expect, it, vi } from 'vitest'
import {
  compactHistory,
  countTurns,
  DEFAULT_HISTORY_WINDOW_TURNS,
  HISTORY_SUMMARY_LABEL,
  planCompaction,
} from './history-window'
import type { ChatMessage } from '../providers/types'

const u = (text: string): ChatMessage => ({ role: 'user', content: text })
const a = (text: string): ChatMessage => ({ role: 'assistant', content: text })
const t = (id: string, text: string): ChatMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: text,
})

function longHistory(turns: number): ChatMessage[] {
  const out: ChatMessage[] = [u('initial goal')]
  for (let i = 0; i < turns; i++) out.push(a(`assistant turn ${i}`))
  return out
}

describe('countTurns / planCompaction', () => {
  it('counts assistant messages only', () => {
    expect(countTurns([u('x'), a('y'), t('1', 'z')])).toBe(1)
  })

  it('returns null when under the window', () => {
    expect(planCompaction(longHistory(10), 40)).toBeNull()
  })

  it('returns null when windowTurns is non-finite / non-positive', () => {
    expect(planCompaction(longHistory(50), Infinity)).toBeNull()
    expect(planCompaction(longHistory(50), 0)).toBeNull()
  })

  it('plans a compaction that preserves the first user message', () => {
    const plan = planCompaction(longHistory(50), 40)
    expect(plan).not.toBeNull()
    expect(plan!.from).toBe(1) // skip initial user message
    expect(plan!.keptTurns).toBe(40)
  })

  it('keeps tool messages bound to their assistant turn', () => {
    const hist: ChatMessage[] = [u('start')]
    for (let i = 0; i < 50; i++) {
      hist.push(a(`t${i}`))
      hist.push(t(`c${i}`, `result ${i}`))
    }
    const plan = planCompaction(hist, 40)!
    // `to` should land right after a tool message, not between assistant+tool.
    const lastInSlice = hist[plan.to - 1]!
    expect(lastInSlice.role).toBe('tool')
  })
})

describe('compactHistory', () => {
  it('is a no-op when under the window', async () => {
    const hist = longHistory(10)
    const out = await compactHistory(hist, 40, async () => 'summary')
    expect(out).toBe(hist)
  })

  it('inserts the summary label between the preserved and kept slices', async () => {
    const hist = longHistory(50)
    const summarise = vi.fn(async () => 'abridged')
    const out = await compactHistory(hist, 40, summarise)
    expect(summarise).toHaveBeenCalledTimes(1)
    expect(out).not.toBe(hist)
    // [initial user, summary assistant, ...40 kept turns]
    expect(out[0]!.role).toBe('user')
    expect(out[1]!.role).toBe('assistant')
    expect(out[1]!.content).toContain(HISTORY_SUMMARY_LABEL)
    expect(out[1]!.content).toContain('abridged')
  })

  it('returns original history when summariser throws', async () => {
    const hist = longHistory(50)
    const out = await compactHistory(hist, 40, async () => {
      throw new Error('nope')
    })
    expect(out).toBe(hist)
  })

  it('returns original history when summary is blank', async () => {
    const hist = longHistory(50)
    const out = await compactHistory(hist, 40, async () => '   ')
    expect(out).toBe(hist)
  })

  it('default window constant is generous', () => {
    expect(DEFAULT_HISTORY_WINDOW_TURNS).toBeGreaterThanOrEqual(30)
  })
})
