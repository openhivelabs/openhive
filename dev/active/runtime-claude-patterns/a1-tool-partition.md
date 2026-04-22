# A1 — Tool Partitioning v2 (3-Class Taxonomy + Concurrency Cap)

> **ADDENDUM (lock-in, 2026-04-22) — plan.md §2, §4 우선.**
> 1. **Phase 1 의 env flag (`OPENHIVE_TOOL_PARTITION_V2`) 는 본 라운드에서 default `1` (활성).** Phase 2 (legacy 제거) 는 1주 dogfooding 후 별도 PR. 본 라운드 acceptance 는 v2 활성 상태에서 측정.
> 2. **Skill `concurrency_class` frontmatter parser (Task 1.4) 는 키만 reserve.** classifier 에서 미사용. 후속 PR.
> 3. **Phase B 첫 작업 (plan §3).** session.ts 충돌 회피 위해 S1/S3/S2 보다 먼저 머지.
> 4. **AsyncQueue 헬퍼**: 기존 `session.ts` 의 inbox/queue 패턴 재사용 (별 모듈 신설 금지). grep `AsyncQueue\|class.*Queue` in `apps/web/lib/server/engine/` → 기존 구현 활용 또는 inline 6줄.

---


**Goal:** 한 turn 안에서 LLM 이 부른 tool_calls 를 "trajectory / serial_write / safe_parallel" 3-class 로 분류하고, safe_parallel 버킷에 동시성 상한 N(=10) 을 강제한다. 같은 turn 에 MCP 20개가 한꺼번에 깨어나는 thundering herd 와 read 와 write 가 동급으로 병렬 실행되는 위험을 막는다.

**Why:** 현재 `splitToolRuns` (`apps/web/lib/server/engine/session.ts:53-76`) 는 단순히 `SERIAL_TOOL_NAMES` (`delegate_to`, `delegate_parallel`, `ask_user`, `set_todos`, `add_todo`, `complete_todo` — trajectory 전용) 를 골라내고 나머지를 한 덩어리 parallel 로 본다. 그래서:

1. **상한 없음**: `tool_calls.length === N` 이면 N개 모두 동시에 fire. MCP RPC, SQL, HTTP fetch 가 한꺼번에 풀린다.
2. **read/write 미구분**: `sql_exec` 같은 mutation 과 `mcp__notion__notion-fetch` 같은 read 가 동일 parallel 버킷에 들어간다. write-write race 가능.
3. **관측 불가**: turn 당 partition shape 가 이벤트로 안 남아서 production 에서 "thundering herd" 가 났는지 확인할 길이 없다.

**Reference (out-of-scope but informs design):** Claude Code 의 `toolOrchestration.ts` 는 tool 마다 `isConcurrencySafe()` 메타로 3-class 분류 후 safe parallel 버킷을 N=10 으로 batch 한다. 우리도 같은 모양으로 가되 OpenHive 의 tool 이름 (`delegate_to`, `mcp__{server}__{tool}`, `run_skill_script`, `sql_exec` 등) 에 맞춘다.

**비범위:**
- Per-skill `concurrency_class` frontmatter override 는 **키만 reserve**, parser 구현은 후속.
- 동적 weight (예: `run_skill_script` 는 2 슬롯 차지) 같은 가중 동시성. 단순 N-cap 만.
- MCP 호출 자체의 timeout/retry. 별도 task.
- LLM 이 같은 tool 을 2번 부르는 dedupe.

---

## 현재 코드 정리 (변경 전 baseline)

### `apps/web/lib/server/engine/session.ts:53-60`
```ts
export const SERIAL_TOOL_NAMES = new Set<string>([
  'delegate_to',
  'delegate_parallel',
  'ask_user',
  'set_todos',
  'add_todo',
  'complete_todo',
])
```

### `apps/web/lib/server/engine/session.ts:65-76`
```ts
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
```

### `apps/web/lib/server/engine/session.ts:869-930` (실행 루프)
- `runs` 를 순회. `run.serial || run.items.length === 1` → for-of 로 sequential. else → 모든 `run.items` 를 `void (async () => …)()` 로 한꺼번에 fire-and-collect.
- 결과는 `results: Array<ExecResult | null>` 에 인덱스 보존, 끝나면 원래 순서대로 `applyResult` → `history.push`. **이 ordering 은 v2 에서도 그대로 유지한다.**

### Tool 이름 출처 (분류 대상 inventory)
- **Trajectory (이미 SERIAL):** `delegate_to`, `delegate_parallel`, `ask_user`, `set_todos`, `add_todo`, `complete_todo` — `apps/web/lib/server/engine/session.ts:53-60`.
- **Skill control:** `activate_skill` (session.ts:1698), `read_skill_file` (session.ts:1743), `run_skill_script` (session.ts:1828, 1859).
- **Team data:** `sql_query` (session.ts:1537), `sql_exec` (session.ts:1555).
- **Built-in:** `web_fetch` (`apps/web/lib/server/tools/webfetch.ts:93`).
- **MCP:** `getTools(name)` 반환 후 `mcp__{server}__{toolName}` 형식으로 wrap. `apps/web/lib/server/mcp/manager.ts:212` 의 `mcp ${name}__${toolName}` 로그가 같은 prefix.
- **Skill-typed tool:** `apps/web/lib/server/tools/base.ts:26` 의 `Tool.skill?` marker — 이게 붙은 건 Python subprocess 타고 나가서 이미 `acquireSkillSlot` 으로 별도 limiter 거침. 하지만 read/write 구분은 메타에 없음 → 기본 `safe_parallel` 로 보고 limiter 두 단(상위 N-cap + 하위 Python slot) 로 막는다.

### 의존성 확인
- `apps/web/package.json` 에 `"p-limit": "^7.3.0"` 이미 존재. 새 deps 불필요.

---

## Phase 1 — Classifier + Bucketing (flag `OPENHIVE_TOOL_PARTITION_V2=1`)

### Task 1.1: `classifyTool` + 상수 분리

**Files:**
- Create: `apps/web/lib/server/engine/tool-partition.ts`

```ts
// apps/web/lib/server/engine/tool-partition.ts
//
// Three-class taxonomy. Used by the engine to decide which tool_calls
// in a single turn can fan out and which must run one-at-a-time.
//
//  - trajectory  : control-flow / run-state-mutating. Always serial.
//                  Same set as legacy SERIAL_TOOL_NAMES.
//  - serial_write: side-effecting mutation (DB write, FS write via
//                  skill script). Serial to avoid intra-turn races.
//  - safe_parallel: reads, network fetches, MCP. Capped at N=10 per
//                  bucket via p-limit; oversize buckets split into
//                  multiple sequential parallel-buckets.

export type ToolClass = 'trajectory' | 'serial_write' | 'safe_parallel'

export const TRAJECTORY_TOOLS = new Set<string>([
  'delegate_to',
  'delegate_parallel',
  'ask_user',
  'set_todos',
  'add_todo',
  'complete_todo',
  'activate_skill', // mutates per-node activated-skill set in run state
])

export const SERIAL_WRITE_TOOLS = new Set<string>([
  'sql_exec',         // DDL/DML on per-team SQLite
  'run_skill_script', // arbitrary Python; can write files / call APIs
])

export const SAFE_PARALLEL_TOOLS = new Set<string>([
  'sql_query',
  'read_skill_file',
  'web_fetch',
])

export function classifyTool(toolName: string): ToolClass {
  if (TRAJECTORY_TOOLS.has(toolName)) return 'trajectory'
  if (SERIAL_WRITE_TOOLS.has(toolName)) return 'serial_write'
  if (SAFE_PARALLEL_TOOLS.has(toolName)) return 'safe_parallel'
  // MCP wrap convention: `mcp__{server}__{tool}` — best-effort safe.
  // (Most MCP tools are reads; write-y ones still get the global N cap.)
  if (toolName.startsWith('mcp__')) return 'safe_parallel'
  // Unknown/custom → conservative default. Reads are the common case
  // for handler-only tools; if a skill author adds a mutating tool
  // without registering it here they should set frontmatter
  // `concurrency_class: serial_write` (Phase 1.4).
  return 'safe_parallel'
}
```

**Steps:**
- [ ] Step 1: 새 파일 생성. `TRAJECTORY_TOOLS` 는 기존 `SERIAL_TOOL_NAMES` 와 동치 + `activate_skill` 추가.
- [ ] Step 2: `apps/web/lib/server/engine/session.ts:53-60` 에서 `SERIAL_TOOL_NAMES` 를 `TRAJECTORY_TOOLS` re-export 로 교체. 기존 import (`TODO_TOOL_NAMES` 등) 는 건드리지 않는다.

### Task 1.2: `partitionRuns` (greedy bucketing + N-cap split)

**Files:**
- Modify: `apps/web/lib/server/engine/tool-partition.ts`

```ts
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

  const flushBucket = () => {
    if (!bucket || bucket.length === 0) return
    // Split oversize bucket into sequential parallel-runs of <= cap.
    for (let i = 0; i < bucket.length; i += cap) {
      runs.push({
        kind: 'parallel',
        cls: 'safe_parallel',
        items: bucket.slice(i, i + cap),
      })
    }
    bucket = null
  }

  for (const tc of calls) {
    const cls = classifyTool(tc.function.name)
    if (cls === 'safe_parallel') {
      ;(bucket ??= []).push(tc)
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
```

**Steps:**
- [ ] Step 1: `partitionRuns` 추가. ordering 은 입력 그대로 보존 — 같은 cls 의 인접 호출만 병합.
- [ ] Step 2: cap=10 일 때 15개 safe_parallel → 10 + 5 두 run 으로 split 되는지 단위 테스트.
- [ ] Step 3: `[mcp_a, sql_exec, mcp_b, mcp_c]` → 3개 run (`[mcp_a]` parallel, `[sql_exec]` serial, `[mcp_b, mcp_c]` parallel) 테스트.
- [ ] Step 4: `[delegate_to, mcp_a, mcp_b]` → `[delegate_to]` serial(trajectory), `[mcp_a, mcp_b]` parallel.

### Task 1.3: 엔진 실행 루프 통합 (env flag-gated)

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts:719-930`

핵심 교체 지점은 line 719 (`const runs = splitToolRuns<TC>(toolCallsForHistory)`) 와 line 869-930 (`for (const run of runs)` 루프).

- [ ] Step 1: 파일 상단에 import 추가:
  ```ts
  import pLimit from 'p-limit'
  import { partitionRuns, type ToolRun } from './tool-partition'
  ```
- [ ] Step 2: env helper:
  ```ts
  function toolPartitionV2Enabled(): boolean {
    return process.env.OPENHIVE_TOOL_PARTITION_V2 === '1'
  }
  function toolParallelMax(): number {
    const raw = Number(process.env.OPENHIVE_TOOL_PARALLEL_MAX)
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10
  }
  ```
- [ ] Step 3: line 719 분기:
  ```ts
  const cap = toolParallelMax()
  const v2 = toolPartitionV2Enabled()
  const partitioned = v2
    ? partitionRuns<TC>(toolCallsForHistory, cap)
    : { runs: legacyToRuns(splitToolRuns<TC>(toolCallsForHistory)), stats: null }
  const runs = partitioned.runs
  ```
  여기서 `legacyToRuns` 는 `{serial, items}` → `{kind, cls, items}` 어댑터 (`kind: serial ? 'serial' : 'parallel'`, `cls: serial ? 'trajectory' : 'safe_parallel'`).
- [ ] Step 4: `partitioned.stats` 가 있으면 turn 시작 직후 (history.push 직후, executeOne 정의 전에) 이벤트 1회 emit:
  ```ts
  if (partitioned.stats) {
    yield makeEvent(
      'tool_run.partitioned',
      sessionId,
      partitioned.stats,
      { depth, node_id: node.id },
    )
  }
  ```
  (`apps/web/lib/server/events/schema.ts` 에 새 kind 등록 필요 — Task 1.5.)
- [ ] Step 5: line 869 의 `for (const run of runs)` 루프를 `kind` 기반으로 다시 씀. 핵심: parallel run 안에서 `pLimit(cap)` 으로 wrap.
  ```ts
  for (const run of runs) {
    if (run.kind === 'serial' || run.items.length === 1) {
      // 기존 sequential 경로 그대로
      for (const tc of run.items) {
        const gen = executeOne(tc)
        let step = await gen.next()
        while (!step.done) { yield step.value; step = await gen.next() }
        applyResult(tc, step.value)
      }
    } else {
      const limit = pLimit(cap)
      const n = run.items.length
      type Item =
        | { kind: 'event'; event: Event }
        | { kind: 'done'; index: number; result: ExecResult }
      const queue = new AsyncQueue<Item>()
      const results: Array<ExecResult | null> = new Array(n).fill(null)

      for (let i = 0; i < n; i++) {
        const tc = run.items[i]!
        const idx = i
        void limit(async () => {
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
              kind: 'done', index: idx,
              result: {
                content: `ERROR: ${exc instanceof Error ? exc.message : String(exc)}`,
                isError: true,
              },
            })
          }
        })
      }

      let completed = 0
      while (completed < n) {
        const item = await queue.pop()
        if (item.kind === 'event') yield item.event
        else { results[item.index] = item.result; completed += 1 }
      }
      for (let i = 0; i < n; i++) applyResult(run.items[i]!, results[i] as ExecResult)
    }
  }
  ```
  주의: `partitionRuns` 가 이미 cap 단위로 bucket 을 split 하므로 `run.items.length <= cap`. `pLimit(cap)` 은 안전망 + 미래에 cap 동적으로 줄어드는 케이스 대비.
- [ ] Step 6: legacy path 보존 — flag off 면 `splitToolRuns` + 기존 루프 그대로 (no pLimit, no event). regression 0.

### Task 1.4: Skill frontmatter 키 reserve (parser 는 stub)

**Files:**
- Modify: `apps/web/lib/server/skills/loader.ts`

- [ ] Step 1: `SkillDef` 인터페이스에 `concurrencyClass?: 'serial_write' | 'safe_parallel'` 필드 optional 추가.
- [ ] Step 2: frontmatter 파싱부에서 `concurrency_class` 키 인식해 위 필드에 매핑 (`'serial_write'|'safe_parallel'` 외 값은 무시).
- [ ] Step 3: **classifier 에서 아직 사용하지 않는다.** 후속 task 에서 `classifyTool` 시그니처를 `(toolName, ctx?: { skillDef? })` 로 확장하고 hook. 지금은 키만 받아 두기.

### Task 1.5: 이벤트 스키마

**Files:**
- Modify: `apps/web/lib/server/events/schema.ts`

- [ ] Step 1: `'tool_run.partitioned'` kind 등록. payload: `{ total: number; parallel_groups: number; serial_count: number; max_parallel_in_group: number }`.
- [ ] Step 2: discriminated union / zod schema 에 추가. timeline UI 는 이번 phase 에서 handle 안 해도 됨 — 모르는 kind 는 그냥 skip.

### Task 1.6: 단위 테스트

**Files:**
- Create: `apps/web/lib/server/engine/tool-partition.test.ts`

- [ ] Step 1: `classifyTool` — trajectory / serial_write / safe_parallel / mcp prefix / unknown 각 케이스.
- [ ] Step 2: `partitionRuns` cap=10:
  - 15개 mcp → 2 parallel run (10, 5).
  - `[mcp_a, sql_exec, mcp_b, mcp_c]` → serial/serial/parallel 순서, items 정확.
  - `[delegate_to, mcp_a, ask_user, mcp_b, mcp_c, sql_exec, mcp_d]` → delegate(s), mcp_a(p), ask_user(s), [mcp_b, mcp_c](p), sql_exec(s), mcp_d(p) — 6 run.
  - 빈 입력 → `{runs: [], stats: {total:0, ...}}`.
- [ ] Step 3: `stats.max_parallel_in_group` 가 split 후 기준인지 (15개 → max 10) 확인.
- [ ] Step 4: ordering — `applyResult` 가 원래 인덱스 순으로 호출되는지 integration 레벨에서 확인 (executeOne mock + 결과 완료 순서를 reverse 해도 history 는 input 순서).

---

## Phase 2 — Default-on + legacy 제거

조건: Phase 1 머지 후 ≥1주 실사용. dev 로그에서 `tool_run.partitioned.max_parallel_in_group > 10` 한 번도 안 뜨고 (= cap 정상 작동), serial_write 분류된 tool 결과가 LLM 시점에 모두 적용되는지 확인.

### Task 2.1: 기본 활성화

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts`

- [ ] Step 1: `toolPartitionV2Enabled()` 의 기본값을 `true` 로. env 가 명시적으로 `'0'` 일 때만 off.
- [ ] Step 2: `CLAUDE.md` 의 "Common Commands" 또는 "Architectural Rules" 섹션에 `OPENHIVE_TOOL_PARALLEL_MAX` env 명시 (1줄).

### Task 2.2: legacy 코드 삭제

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts`

- [ ] Step 1: `splitToolRuns` 함수 (line 65-76) 와 `legacyToRuns` 어댑터 제거.
- [ ] Step 2: 기존 `SERIAL_TOOL_NAMES` export 는 하위 호환을 위해 남겨두되 (다른 파일에서 import 할 가능성) `TRAJECTORY_TOOLS` re-export 로 alias.
- [ ] Step 3: `toolPartitionV2Enabled` 헬퍼 제거. 분기 없앰.

### Task 2.3: env flag 문서화 / cleanup

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (top-level comment)
- Modify: `CLAUDE.md`

- [ ] Step 1: `OPENHIVE_TOOL_PARALLEL_MAX` (default 10) 를 CLAUDE.md "Tech Stack (핵심)" 마지막에 1줄. `OPENHIVE_PYTHON_CONCURRENCY` 처럼 표기.
- [ ] Step 2: `OPENHIVE_TOOL_PARTITION_V2` 는 dead env 가 되므로 README/문서에 등장 안 함.

---

## Configuration

| Env | Default | 효과 |
|---|---|---|
| `OPENHIVE_TOOL_PARALLEL_MAX` | `10` | 한 parallel bucket 의 최대 동시성. 초과분은 다음 bucket 으로 split. |
| `OPENHIVE_TOOL_PARTITION_V2` | `1` (Phase 2 부터) | v1 코드로 fallback 하고 싶을 때 `0`. Phase 2 에서 제거. |

`getSettings()` (`apps/web/lib/server/config.ts`) 에 노출할 필요 없음 — 순수 server 런타임 토글이라 env 직접 read 가 자연스럽다.

---

## Result Ordering 보존 (regression 방지)

`applyResult(tc, res)` 는 항상 `run.items` 의 인덱스 순서로 호출된다. parallel 실행 안에서 어느 호출이 먼저 끝나든 `results[idx] = res` 로 슬롯에 박은 뒤, run 끝에서 `for (let i = 0; i < n; i++) applyResult(run.items[i], results[i])` — 이 contract 는 v1 = v2 동일. `history.push({role:'tool', tool_call_id, content})` 가 OpenAI/Anthropic chat history 의 tool message ordering 요구사항을 깨지 않기 위함.

추가로 v2 에서 cap-split 으로 한 turn 의 safe_parallel 이 여러 run 으로 쪼개져도 **run 간 순서도 입력 순서** 이므로 history 는 그대로 결정적이다.

---

## Observability

- 새 이벤트 `tool_run.partitioned`. payload:
  ```json
  { "total": 15, "parallel_groups": 2, "serial_count": 0, "max_parallel_in_group": 10 }
  ```
- meta: `{ depth, node_id }`. tool 이름 단위가 아니라 turn 단위 1회.
- 활용: `events.jsonl` grep 으로 "한 turn 에 11개 이상 fan-out 된 사례" 추적 → cap 튜닝 / MCP 의심 server 식별.
- Run 캔버스 / Timeline UI 는 unknown event kind 는 무시하므로 즉시 broken 되진 않는다. UI 시각화는 후속 task.

---

## Test Plan

### Unit (`tool-partition.test.ts`)

- [ ] `classifyTool('delegate_to') === 'trajectory'`
- [ ] `classifyTool('sql_exec') === 'serial_write'`
- [ ] `classifyTool('sql_query') === 'safe_parallel'`
- [ ] `classifyTool('web_fetch') === 'safe_parallel'`
- [ ] `classifyTool('mcp__notion__notion-fetch') === 'safe_parallel'`
- [ ] `classifyTool('made_up_tool') === 'safe_parallel'` (default)
- [ ] `partitionRuns([], 10)` → `runs: []`, stats zero.
- [ ] 15× mcp → `runs.length === 2`, items lengths `[10, 5]`, `parallel_groups === 2`, `max_parallel_in_group === 10`.
- [ ] `[mcp_a, sql_exec, mcp_b, mcp_c]` → 3 runs, 두번째 run `kind:'serial'` `cls:'serial_write'`.
- [ ] `[delegate_to, mcp_a]` → 2 runs (serial trajectory, parallel).
- [ ] cap=1 edge: 모든 tool 이 singleton run 으로 떨어짐.

### Integration (engine smoke)

- [ ] Mock provider 로 `tool_calls` 가 12개 (전부 stub MCP) 인 turn 만들고, 실제 동시 in-flight 가 10 을 넘지 않는지 — `executeOne` mock 안에 카운터 + assert.
- [ ] `tool_run.partitioned` 이벤트가 `events.jsonl` 에 기록되는지.
- [ ] `delegate_to` 가 mcp 호출들과 섞였을 때 delegation 이 다른 tool 과 동시 실행되지 않음 (현행 보장 유지).
- [ ] `sql_exec` 가 같은 turn 의 `sql_query` 와 별 run 으로 분리되는지.

### Manual

- [ ] `OPENHIVE_TOOL_PARTITION_V2=1 OPENHIVE_TOOL_PARALLEL_MAX=3 pnpm --filter @openhive/web dev` 로 띄우고 MCP 가 많이 붙은 팀에서 일부러 "list 5 notion pages, 5 slack channels, 3 drive files" 시켜보기. partition stats 가 `{total:13, parallel_groups: 5, max_parallel_in_group: 3}` 비슷하게 나오는지.
- [ ] flag 끈 상태로 같은 시나리오 → 단일 parallel bucket 13 동시. 비교용.

---

## 리스크 / 주의

- **MCP 안에 mutation 있는 tool**: 예 `mcp__notion__notion-update-page`. 현재는 전부 `safe_parallel` 로 분류됨. 같은 페이지를 동시에 update 하면 last-write-wins. 이건 LLM 책임 영역 + 후속 per-server allowlist 로 다룰 사안. Phase 1 범위 밖.
- **`run_skill_script` 가 serial 로 가면 throughput ↓**: 현재 LLM 이 같은 turn 에 skill script 를 2개 부르는 케이스는 드물지만 (skill 활성 후 1회가 정상 패턴), 만약 자주 발생하면 `concurrency_class: safe_parallel` frontmatter 로 opt-in 할 수 있게 Phase 1.4 키를 미리 reserve.
- **Python skill limiter 와 중복**: `runSkillInvocation` 안에서 이미 `acquireSkillSlot` (default 2-4) 으로 막힌다. 상위 N=10 cap + 하위 Python slot 2-4 → 실효 동시 Python 은 2-4 그대로. 다른 safe_parallel (MCP/web_fetch/sql_query) 은 N=10 까지. 의도된 layering.
- **`activate_skill` trajectory 승격**: 기존엔 parallel 이었음. activate 가 run-state (`state().activatedSkills`) 를 mutate 하므로 trajectory 가 맞다. 같은 turn 에 activate 2개 부르는 케이스 = LLM 의 비정상 동작 → 어차피 serial 이 안전.
- **AsyncQueue back-pressure 없음**: parallel run 에서 안쪽 generator 가 token event 를 빠르게 push 하면 queue 가 unbounded 로 자랄 수 있음. v1 도 동일한 문제고 cap=10 이면 실제로는 10× burst 라 무시 가능. 별도 task 로 분리.
- **`splitToolRuns` 외부 import**: grep 결과 같은 파일 내부에서만 사용. 제거 안전. (Phase 2.2 전 다시 grep 확인 필요.)
