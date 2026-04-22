/**
 * Tool partitioning v2 — 3-class taxonomy + concurrency cap.
 *
 * A turn's tool_calls are classified into:
 *   - trajectory   : control-flow / run-state-mutating. Always serial.
 *                    Equivalent to the legacy SERIAL_TOOL_NAMES set.
 *   - serial_write : side-effecting mutation (DB write, arbitrary skill
 *                    script). Serial to avoid intra-turn races.
 *   - safe_parallel: reads, network fetches, MCP. Capped at N per bucket
 *                    via pLimit; oversize buckets split into multiple
 *                    sequential parallel-buckets.
 *
 * Ordering contract: adjacent same-class calls merge into one run. Input
 * order inside each run is preserved so provider history stays
 * deterministic. When a safe_parallel bucket exceeds `cap`, it is split
 * into consecutive parallel runs of <= cap each (still in input order).
 */

export type ToolClass = 'trajectory' | 'serial_write' | 'safe_parallel'

/** Legacy SERIAL_TOOL_NAMES + activate_skill (mutates run-scoped skill set). */
export const TRAJECTORY_TOOLS = new Set<string>([
  'delegate_to',
  'delegate_parallel',
  'ask_user',
  'set_todos',
  'add_todo',
  'complete_todo',
  'activate_skill',
])

export const SERIAL_WRITE_TOOLS = new Set<string>([
  'sql_exec', // DDL/DML on per-team SQLite
  'run_skill_script', // arbitrary Python; can write files / call APIs
])

export const SAFE_PARALLEL_TOOLS = new Set<string>(['sql_query', 'read_skill_file', 'web_fetch'])

export function classifyTool(toolName: string): ToolClass {
  if (TRAJECTORY_TOOLS.has(toolName)) return 'trajectory'
  if (SERIAL_WRITE_TOOLS.has(toolName)) return 'serial_write'
  if (SAFE_PARALLEL_TOOLS.has(toolName)) return 'safe_parallel'
  // MCP wrap convention: `mcp__{server}__{tool}` — best-effort safe.
  // (Most MCP tools are reads; write-y ones still get the global N cap.)
  if (toolName.startsWith('mcp__')) return 'safe_parallel'
  // Unknown/custom → conservative default. Skill authors that register a
  // mutating handler should opt into `concurrency_class: serial_write`
  // frontmatter (reserved key; not wired in this phase).
  return 'safe_parallel'
}

export interface ToolRun<T> {
  kind: 'parallel' | 'serial'
  cls: ToolClass
  items: T[]
}

export interface PartitionStats {
  total: number
  parallel_groups: number
  serial_count: number
  max_parallel_in_group: number
}

export function partitionRuns<T extends { function: { name: string } }>(
  calls: T[],
  cap: number,
): { runs: ToolRun<T>[]; stats: PartitionStats } {
  const runs: ToolRun<T>[] = []
  let bucket: T[] | null = null
  const effectiveCap = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 10

  const flushBucket = () => {
    if (!bucket || bucket.length === 0) {
      bucket = null
      return
    }
    for (let i = 0; i < bucket.length; i += effectiveCap) {
      runs.push({
        kind: 'parallel',
        cls: 'safe_parallel',
        items: bucket.slice(i, i + effectiveCap),
      })
    }
    bucket = null
  }

  for (const tc of calls) {
    const cls = classifyTool(tc.function.name)
    if (cls === 'safe_parallel') {
      if (bucket === null) bucket = []
      bucket.push(tc)
    } else {
      flushBucket()
      runs.push({ kind: 'serial', cls, items: [tc] })
    }
  }
  flushBucket()

  let maxParallel = 0
  let parallelGroups = 0
  let serialCount = 0
  for (const r of runs) {
    if (r.kind === 'parallel') {
      parallelGroups += 1
      if (r.items.length > maxParallel) maxParallel = r.items.length
    } else {
      serialCount += 1
    }
  }
  return {
    runs,
    stats: {
      total: calls.length,
      parallel_groups: parallelGroups,
      serial_count: serialCount,
      max_parallel_in_group: maxParallel,
    },
  }
}
