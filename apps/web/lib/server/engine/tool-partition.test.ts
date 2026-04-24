import pLimit from 'p-limit'
import { describe, expect, it } from 'vitest'
import {
  PARALLEL_TRAJECTORY_TOOLS,
  SAFE_PARALLEL_TOOLS,
  SERIAL_WRITE_TOOLS,
  TRAJECTORY_TOOLS,
  classifyTool,
  partitionRuns,
} from './tool-partition'

function tc(name: string, id = name) {
  return { id, function: { name, arguments: '{}' } }
}

function ids(run: { items: Array<{ id: string }> } | undefined): string[] {
  return run?.items.map((x) => x.id) ?? []
}

describe('classifyTool', () => {
  it('trajectory tools (serial)', () => {
    expect(classifyTool('delegate_parallel')).toBe('trajectory')
    expect(classifyTool('ask_user')).toBe('trajectory')
    expect(classifyTool('set_todos')).toBe('trajectory')
    expect(classifyTool('add_todo')).toBe('trajectory')
    expect(classifyTool('complete_todo')).toBe('trajectory')
    expect(classifyTool('activate_skill')).toBe('trajectory')
  })

  it('parallel_trajectory tools (concurrent fan-out)', () => {
    expect(classifyTool('delegate_to')).toBe('parallel_trajectory')
  })

  it('serial_write tools', () => {
    expect(classifyTool('sql_exec')).toBe('serial_write')
    expect(classifyTool('run_skill_script')).toBe('serial_write')
  })

  it('safe_parallel tools', () => {
    expect(classifyTool('sql_query')).toBe('safe_parallel')
    expect(classifyTool('read_skill_file')).toBe('safe_parallel')
    expect(classifyTool('web-fetch')).toBe('safe_parallel')
    expect(classifyTool('web-search')).toBe('safe_parallel')
  })

  it('mcp prefix defaults to safe_parallel', () => {
    expect(classifyTool('mcp__notion__notion-fetch')).toBe('safe_parallel')
    expect(classifyTool('mcp__slack__send')).toBe('safe_parallel')
  })

  it('unknown tools default to safe_parallel', () => {
    expect(classifyTool('made_up_tool')).toBe('safe_parallel')
  })

  it('taxonomy sets are disjoint', () => {
    for (const n of TRAJECTORY_TOOLS) {
      expect(PARALLEL_TRAJECTORY_TOOLS.has(n)).toBe(false)
      expect(SERIAL_WRITE_TOOLS.has(n)).toBe(false)
      expect(SAFE_PARALLEL_TOOLS.has(n)).toBe(false)
    }
    for (const n of PARALLEL_TRAJECTORY_TOOLS) {
      expect(SERIAL_WRITE_TOOLS.has(n)).toBe(false)
      expect(SAFE_PARALLEL_TOOLS.has(n)).toBe(false)
    }
    for (const n of SERIAL_WRITE_TOOLS) {
      expect(SAFE_PARALLEL_TOOLS.has(n)).toBe(false)
    }
  })
})

describe('partitionRuns', () => {
  it('empty input', () => {
    const out = partitionRuns([], 10)
    expect(out.runs).toEqual([])
    expect(out.stats).toEqual({
      total: 0,
      parallel_groups: 0,
      serial_count: 0,
      max_parallel_in_group: 0,
    })
  })

  it('splits 15× mcp into two parallel runs of 10 + 5 with cap=10', () => {
    const calls = Array.from({ length: 15 }, (_, i) => tc(`mcp__s__t${i}`, `c${i}`))
    const { runs, stats } = partitionRuns(calls, 10)
    expect(runs.length).toBe(2)
    expect(runs[0]?.kind).toBe('parallel')
    expect(runs[0]?.cls).toBe('safe_parallel')
    expect(runs[0]?.items.length).toBe(10)
    expect(runs[1]?.items.length).toBe(5)
    expect(ids(runs[0])).toEqual(calls.slice(0, 10).map((x) => x.id))
    expect(ids(runs[1])).toEqual(calls.slice(10).map((x) => x.id))
    expect(stats).toEqual({
      total: 15,
      parallel_groups: 2,
      serial_count: 0,
      max_parallel_in_group: 10,
    })
  })

  it('interleaves serial_write between parallel buckets', () => {
    const calls = [
      tc('mcp__a__x', 'a'),
      tc('sql_exec', 'b'),
      tc('mcp__b__x', 'c'),
      tc('mcp__c__x', 'd'),
    ]
    const { runs, stats } = partitionRuns(calls, 10)
    expect(runs.length).toBe(3)
    expect(runs[0]).toMatchObject({ kind: 'parallel', cls: 'safe_parallel' })
    expect(ids(runs[0])).toEqual(['a'])
    expect(runs[1]).toMatchObject({ kind: 'serial', cls: 'serial_write' })
    expect(ids(runs[1])).toEqual(['b'])
    expect(runs[2]).toMatchObject({ kind: 'parallel', cls: 'safe_parallel' })
    expect(ids(runs[2])).toEqual(['c', 'd'])
    expect(stats.total).toBe(4)
    expect(stats.parallel_groups).toBe(2)
    expect(stats.serial_count).toBe(1)
    expect(stats.max_parallel_in_group).toBe(2)
  })

  it('trajectory + parallel mix preserves order', () => {
    const calls = [
      tc('delegate_parallel', 'dp'),
      tc('mcp__a__x', 'a'),
      tc('ask_user', 'u'),
      tc('mcp__b__x', 'b'),
      tc('mcp__c__x', 'c'),
      tc('sql_exec', 's'),
      tc('mcp__d__x', 'd2'),
    ]
    const { runs } = partitionRuns(calls, 10)
    expect(runs.length).toBe(6)
    expect(runs[0]).toMatchObject({ kind: 'serial', cls: 'trajectory' })
    expect(ids(runs[0])).toEqual(['dp'])
    expect(runs[1]).toMatchObject({ kind: 'parallel', cls: 'safe_parallel' })
    expect(ids(runs[1])).toEqual(['a'])
    expect(runs[2]).toMatchObject({ kind: 'serial', cls: 'trajectory' })
    expect(ids(runs[2])).toEqual(['u'])
    expect(runs[3]).toMatchObject({ kind: 'parallel', cls: 'safe_parallel' })
    expect(ids(runs[3])).toEqual(['b', 'c'])
    expect(runs[4]).toMatchObject({ kind: 'serial', cls: 'serial_write' })
    expect(ids(runs[4])).toEqual(['s'])
    expect(runs[5]).toMatchObject({ kind: 'parallel', cls: 'safe_parallel' })
    expect(ids(runs[5])).toEqual(['d2'])
  })

  it('delegate_to followed by mcp yields 2 parallel runs of different classes', () => {
    const calls = [tc('delegate_to', 'd'), tc('mcp__a__x', 'a')]
    const { runs } = partitionRuns(calls, 10)
    // Both are parallel-class but DIFFERENT classes (parallel_trajectory
    // vs safe_parallel) — distinct caps, distinct buckets, order preserved.
    expect(runs.length).toBe(2)
    expect(runs[0]).toMatchObject({ kind: 'parallel', cls: 'parallel_trajectory' })
    expect(ids(runs[0])).toEqual(['d'])
    expect(runs[1]).toMatchObject({ kind: 'parallel', cls: 'safe_parallel' })
    expect(ids(runs[1])).toEqual(['a'])
  })

  it('multiple adjacent delegate_to collapse into one parallel_trajectory bucket', () => {
    const calls = [
      tc('delegate_to', 'd1'),
      tc('delegate_to', 'd2'),
      tc('delegate_to', 'd3'),
    ]
    const { runs, stats } = partitionRuns(calls, 10)
    expect(runs.length).toBe(1)
    expect(runs[0]).toMatchObject({ kind: 'parallel', cls: 'parallel_trajectory' })
    expect(ids(runs[0])).toEqual(['d1', 'd2', 'd3'])
    expect(stats.parallel_groups).toBe(1)
    expect(stats.max_parallel_in_group).toBe(3)
  })

  it('per-class caps split buckets independently', () => {
    // 6 delegate_to + 6 mcp_ calls adjacent; parallel_trajectory cap=2,
    // safe_parallel cap=4. Expect: 3 pt buckets of 2, then 2 sp buckets (4+2).
    const calls = [
      ...Array.from({ length: 6 }, (_, i) => tc('delegate_to', `d${i}`)),
      ...Array.from({ length: 6 }, (_, i) => tc('mcp__s__t', `m${i}`)),
    ]
    const { runs } = partitionRuns(calls, {
      safe_parallel: 4,
      parallel_trajectory: 2,
    })
    expect(runs.length).toBe(5)
    expect(runs[0]).toMatchObject({ kind: 'parallel', cls: 'parallel_trajectory' })
    expect(ids(runs[0])).toEqual(['d0', 'd1'])
    expect(runs[1]).toMatchObject({ kind: 'parallel', cls: 'parallel_trajectory' })
    expect(ids(runs[1])).toEqual(['d2', 'd3'])
    expect(runs[2]).toMatchObject({ kind: 'parallel', cls: 'parallel_trajectory' })
    expect(ids(runs[2])).toEqual(['d4', 'd5'])
    expect(runs[3]).toMatchObject({ kind: 'parallel', cls: 'safe_parallel' })
    expect(ids(runs[3])).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(runs[4]).toMatchObject({ kind: 'parallel', cls: 'safe_parallel' })
    expect(ids(runs[4])).toEqual(['m4', 'm5'])
  })

  it('trajectory serial break splits delegate_to batches', () => {
    // set_todos in the middle prevents the two delegate_to groups from
    // merging — the trajectory serial tool forces a flush + its own serial
    // run + reopens a new parallel bucket after.
    const calls = [
      tc('delegate_to', 'd1'),
      tc('delegate_to', 'd2'),
      tc('set_todos', 't'),
      tc('delegate_to', 'd3'),
    ]
    const { runs } = partitionRuns(calls, 10)
    expect(runs.length).toBe(3)
    expect(runs[0]).toMatchObject({ kind: 'parallel', cls: 'parallel_trajectory' })
    expect(ids(runs[0])).toEqual(['d1', 'd2'])
    expect(runs[1]).toMatchObject({ kind: 'serial', cls: 'trajectory' })
    expect(ids(runs[1])).toEqual(['t'])
    expect(runs[2]).toMatchObject({ kind: 'parallel', cls: 'parallel_trajectory' })
    expect(ids(runs[2])).toEqual(['d3'])
  })

  it('cap=1 forces singleton parallel runs', () => {
    const calls = [tc('mcp__a__x', 'a'), tc('mcp__b__x', 'b'), tc('mcp__c__x', 'c')]
    const { runs, stats } = partitionRuns(calls, 1)
    expect(runs.length).toBe(3)
    for (const r of runs) {
      expect(r.kind).toBe('parallel')
      expect(r.items.length).toBe(1)
    }
    expect(stats.parallel_groups).toBe(3)
    expect(stats.max_parallel_in_group).toBe(1)
  })

  it('stats.max_parallel_in_group reflects post-split bucket size', () => {
    const calls = Array.from({ length: 25 }, (_, i) => tc(`mcp__s__t${i}`, `c${i}`))
    const { runs, stats } = partitionRuns(calls, 10)
    expect(runs.map((r) => r.items.length)).toEqual([10, 10, 5])
    expect(stats.max_parallel_in_group).toBe(10)
    expect(stats.parallel_groups).toBe(3)
    expect(stats.total).toBe(25)
  })

  it('only serial_write → no parallel groups', () => {
    const calls = [tc('sql_exec', 'a'), tc('run_skill_script', 'b')]
    const { runs, stats } = partitionRuns(calls, 10)
    expect(runs.length).toBe(2)
    expect(runs.every((r) => r.kind === 'serial')).toBe(true)
    expect(stats.parallel_groups).toBe(0)
    expect(stats.serial_count).toBe(2)
    expect(stats.max_parallel_in_group).toBe(0)
  })

  it('only trajectory (no delegate_to) → all serial', () => {
    const calls = [tc('ask_user', 'a'), tc('set_todos', 'b'), tc('activate_skill', 'c')]
    const { runs, stats } = partitionRuns(calls, 10)
    expect(runs.length).toBe(3)
    expect(runs.every((r) => r.kind === 'serial' && r.cls === 'trajectory')).toBe(true)
    expect(stats.parallel_groups).toBe(0)
    expect(stats.serial_count).toBe(3)
  })

  it('pLimit(cap) caps in-flight concurrency at cap for a 12-stub bucket', async () => {
    // Mirrors the session.ts parallel-run loop: partitionRuns produces at
    // most `cap`-sized buckets, and the engine runs each bucket under
    // pLimit(cap). This test seeds 12 stubs with cap=10 and asserts the
    // observed concurrent in-flight count never exceeds 10.
    const calls = Array.from({ length: 12 }, (_, i) => tc(`mcp__s__t${i}`, `c${i}`))
    const { runs } = partitionRuns(calls, 10)
    expect(runs.map((r) => r.items.length)).toEqual([10, 2])

    let inFlight = 0
    let peak = 0
    const run = async () => {
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
    }

    for (const r of runs) {
      const limit = pLimit(10)
      await Promise.all(r.items.map(() => limit(run)))
    }
    expect(peak).toBeLessThanOrEqual(10)
  })

  it('invalid cap falls back to 10', () => {
    const calls = Array.from({ length: 12 }, (_, i) => tc(`mcp__s__t${i}`, `c${i}`))
    const { runs } = partitionRuns(calls, Number.NaN)
    expect(runs.map((r) => r.items.length)).toEqual([10, 2])
  })
})
