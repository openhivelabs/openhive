import { describe, expect, it } from 'vitest'
import {
  renderTodosSection,
  SERIAL_TOOL_NAMES,
  splitToolRuns,
  type TodoItem,
} from './session'

const tc = (name: string) => ({ function: { name } })

describe('splitToolRuns', () => {
  it('collapses contiguous parallel-safe calls into one run', () => {
    const runs = splitToolRuns([
      tc('notion__search'),
      tc('notion__fetch'),
      tc('read_skill_file'),
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.serial).toBe(false)
    expect(runs[0]!.items).toHaveLength(3)
  })

  it('isolates serial tools into their own runs', () => {
    const runs = splitToolRuns([
      tc('notion__search'),
      tc('delegate_to'),
      tc('notion__fetch'),
    ])
    expect(runs.map((r) => r.serial)).toEqual([false, true, false])
    expect(runs.map((r) => r.items.length)).toEqual([1, 1, 1])
  })

  it('keeps adjacent serial tools serial (same run)', () => {
    const runs = splitToolRuns([
      tc('delegate_to'),
      tc('ask_user'),
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.serial).toBe(true)
  })

  it('empty input yields zero runs', () => {
    expect(splitToolRuns([])).toEqual([])
  })

  it('recognises all documented serial tools', () => {
    for (const name of [
      'delegate_to',
      'delegate_parallel',
      'ask_user',
      'set_todos',
      'add_todo',
      'complete_todo',
    ]) {
      expect(SERIAL_TOOL_NAMES.has(name)).toBe(true)
    }
  })

  it('treats MCP and skill tools as parallel-safe', () => {
    for (const name of [
      'notion__search',
      'web__fetch',
      'read_skill_file',
      'run_skill_script',
      'read_team_data',
    ]) {
      expect(SERIAL_TOOL_NAMES.has(name)).toBe(false)
    }
  })
})

describe('renderTodosSection', () => {
  const todo = (id: string, text: string, done = false): TodoItem => ({
    id,
    text,
    done,
  })

  it('returns empty string when no todos', () => {
    expect(renderTodosSection([])).toBe('')
  })

  it('renders pending/done counts in the header', () => {
    const out = renderTodosSection([
      todo('a', 'one'),
      todo('b', 'two', true),
      todo('c', 'three'),
    ])
    expect(out).toContain('2 pending, 1 done')
  })

  it('uses checkbox marks and shows the id', () => {
    const out = renderTodosSection([
      todo('todo_aa', 'first'),
      todo('todo_bb', 'second', true),
    ])
    expect(out).toContain('1. [ ] first')
    expect(out).toContain('2. [x] second')
    expect(out).toContain('id: todo_aa')
    expect(out).toContain('id: todo_bb')
  })
})
