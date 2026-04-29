/**
 * Tool partitioning v2 — 4-class taxonomy + per-class concurrency caps.
 *
 * A turn's tool_calls are classified into:
 *   - trajectory          : control-flow / run-state-mutating. Always serial.
 *                           (set_todos, ask_user, activate_skill — each
 *                           changes state the next tool in the batch may
 *                           observe, so they cannot overlap.)
 *   - parallel_trajectory : launches an independent sub-computation keyed
 *                           by its own (parent→child) scope. Adjacent calls
 *                           fan out concurrently under a dedicated cap.
 *                           `delegate_to` lives here: two delegates to
 *                           DIFFERENT subordinates own disjoint pair-
 *                           counters, scratch dirs, and ledger rows, so
 *                           overlapping them is safe. `delegate_parallel`
 *                           stays in trajectory — it already fans out
 *                           internally and mixes with set_todos ordering.
 *   - serial_write        : side-effecting mutation (DB write, arbitrary
 *                           skill script). Serial to avoid intra-turn races.
 *   - safe_parallel       : reads, network fetches, MCP. Capped at N per
 *                           bucket via pLimit; oversize buckets split into
 *                           multiple sequential parallel-buckets.
 *
 * Ordering contract: adjacent same-class calls merge into one run. Input
 * order inside each run is preserved so provider history stays
 * deterministic. Parallel buckets (either class) that exceed their cap are
 * split into consecutive parallel runs of <= cap each (still input order).
 */

type ToolClass =
  | 'trajectory'
  | 'parallel_trajectory'
  | 'serial_write'
  | 'safe_parallel'

/** Serial control-flow tools. Each mutates run-scoped state that the next
 *  tool in the same batch may read (todos list, ask_user inbox, skill
 *  activation set), so these must not overlap.
 *
 *  `delegate_parallel` stays here even though it's a fan-out: it takes a
 *  single sub and spawns N siblings internally, so ordering against other
 *  trajectory tools still matters. `delegate_to` moved to
 *  `parallel_trajectory` — see `PARALLEL_TRAJECTORY_TOOLS`. */
export const TRAJECTORY_TOOLS = new Set<string>([
  'delegate_parallel',
  'ask_user',
  'set_todos',
  'add_todo',
  'complete_todo',
  'activate_skill',
])

/** Independent-parallel control-flow tools. Multiple calls can run
 *  concurrently because each owns a disjoint scope (sub-agent instance,
 *  pair counter, scratch dir, ledger entry). Capped via
 *  `OPENHIVE_PARALLEL_DELEGATION_MAX` at the dispatch site — not the
 *  generic safe_parallel cap, since each branch fires an LLM stream and
 *  we don't want to mix 4 LLM runs with 10 concurrent web_fetches. */
export const PARALLEL_TRAJECTORY_TOOLS = new Set<string>([
  'delegate_to',
])

export const SERIAL_WRITE_TOOLS = new Set<string>([
  'db_exec', // DDL/DML on per-team SQLite
  'db_install_template', // applies a vetted CREATE TABLE
  'run_skill_script', // arbitrary Python; can write files / call APIs
  // Panel/dashboard mutations — install-lock serialises per team, but at the
  // tool layer they still need serial_write so coexistent calls in the same
  // batch don't overlap reads of dashboard.yaml against pending writes.
  'panel_install',
  'panel_update_binding',
  'panel_set_position',
  'panel_set_props',
  'panel_delete',
  'panel_execute_action',
  'dashboard_restore_backup',
])

export const SAFE_PARALLEL_TOOLS = new Set<string>([
  'db_describe',
  'db_query',
  'db_explain',
  'db_read_guide',
  'read_skill_file',
  // Typed skills that are read-only networked calls — exactly the safe-parallel
  // shape. Listed by skill name (kebab-case, matches SKILL.md `name` frontmatter
  // which becomes the tool's name in the LLM catalog).
  'web-fetch',
  'web-search',
  // Panel/dashboard reads.
  'panel_list',
  'panel_get',
  'panel_market_list',
  'panel_refresh',
  'panel_get_data',
  'dashboard_list_backups',
])

export function classifyTool(toolName: string): ToolClass {
  if (PARALLEL_TRAJECTORY_TOOLS.has(toolName)) return 'parallel_trajectory'
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

interface PartitionStats {
  total: number
  parallel_groups: number
  serial_count: number
  max_parallel_in_group: number
}

/** Per-class cap resolver passed in by the dispatch site so tests / env
 *  overrides can tune each bucket independently without this module
 *  having to know about env vars. */
interface PartitionCaps {
  safe_parallel: number
  parallel_trajectory: number
}

/** Back-compat: legacy callers passed a single cap meaning the
 *  safe_parallel bucket size. Map to PartitionCaps with the same default
 *  for parallel_trajectory (caller should override with a smaller value
 *  for LLM-heavy fan-out — see session.ts parallelDelegationMax). */
function normaliseCaps(cap: number | PartitionCaps): PartitionCaps {
  if (typeof cap === 'number') {
    const n = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 10
    return { safe_parallel: n, parallel_trajectory: n }
  }
  return {
    safe_parallel:
      Number.isFinite(cap.safe_parallel) && cap.safe_parallel >= 1
        ? Math.floor(cap.safe_parallel)
        : 10,
    parallel_trajectory:
      Number.isFinite(cap.parallel_trajectory) && cap.parallel_trajectory >= 1
        ? Math.floor(cap.parallel_trajectory)
        : 4,
  }
}

export function partitionRuns<T extends { function: { name: string } }>(
  calls: T[],
  cap: number | PartitionCaps,
): { runs: ToolRun<T>[]; stats: PartitionStats } {
  const runs: ToolRun<T>[] = []
  const caps = normaliseCaps(cap)
  // A bucket is a contiguous run of same-class parallel-eligible calls.
  // We only track one at a time because classes other than the current
  // bucket's class (or any serial class) force a flush.
  let bucket: { cls: 'safe_parallel' | 'parallel_trajectory'; items: T[] } | null = null

  const flushBucket = () => {
    if (!bucket || bucket.items.length === 0) {
      bucket = null
      return
    }
    const { cls, items } = bucket
    const effCap = caps[cls]
    for (let i = 0; i < items.length; i += effCap) {
      runs.push({
        kind: 'parallel',
        cls,
        items: items.slice(i, i + effCap),
      })
    }
    bucket = null
  }

  for (const tc of calls) {
    const cls = classifyTool(tc.function.name)
    if (cls === 'safe_parallel' || cls === 'parallel_trajectory') {
      if (bucket === null || bucket.cls !== cls) {
        // Different parallel-class breaks the current bucket — provider
        // history stays deterministic as long as input order across the
        // boundary is preserved, which flushing achieves.
        flushBucket()
        bucket = { cls, items: [] }
      }
      bucket.items.push(tc)
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
