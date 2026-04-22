# S2 — Time-based Microcompact (stale tool_result clearing)

> **ADDENDUM (lock-in, 2026-04-22) — plan.md §2, §4 우선.**
> 1. **트리거는 시간축 only (v1).** A4 의 `shouldMicrocompact` 와 AND 조건은 v2. 본 라운드는 `STALE_AFTER_MS` + `OPENHIVE_MICROCOMPACT_MIN_CHARS` 만.
> 2. **`maybeMicrocompact` 시그니처에 `sessionId: string` 추가** (A3 placeholder 강화에 필요). `streamTurn` (`session.ts:627`) 호출 시 sessionId 그대로 통과. A3 가 머지된 후 placeholder 포맷 변경.
> 3. **`COMPACTABLE_BUILTIN` set 에 `read_artifact` 추가** (A3 머지 시 동시 적용). 본 spec PR 에선 set 만 export, A3 PR 에서 한 줄 추가.
> 4. **A3 의존성**: A3 Phase 2 가 본 spec 의 placeholder 포맷을 강화. 즉 S2 → A3 순서 (plan §3 Phase B → C).

---


**Goal:** 긴 Lead 세션에서 식어버린(stale) tool_result 메시지를 in-place 로 비워, 다음 턴 프롬프트를 가볍게 만든다. Claude Code 의 `microCompact` 패턴 중 **provider-agnostic time-based path** 만 채택. cache_edits API path 는 Anthropic-only beta 라 보류.

**Why now:** `apps/web/lib/server/engine/session.ts:568` — `historyWindow = Number.POSITIVE_INFINITY`. 즉 현재 Lead 의 `externalHistory` 는 절대 줄어들지 않는다. MCP 호출 / `web_fetch` / `sql_query` / `read_skill_file` 결과는 한 번 LLM 이 소비하고 나면 실질적으로 죽은 텍스트인데, 다음 턴 프롬프트에 계속 박혀서 input token 을 끌어올린다. 30분짜리 리포팅 세션에서 prompt 가 단조 증가 → 캐시 hit 도 갉아먹는다.

**핵심 설계:**
- **Time-based**: 마지막 assistant 메시지 timestamp 와 "지금" 의 차이가 `STALE_AFTER_MS` 를 넘으면 → provider 측 prefix cache 는 어차피 만료(=cold). 이 시점에 history 를 mutate 해도 캐시 미스 손해 없음. 반대로 cache 가 hot (recent) 이면 microcompact **금지** — 깨면 더 손해.
- **Whitelist 방식**: 안전한 도구만 비운다. 델리게이션 / ask_user / TODO 같은 trajectory-encoding 도구는 절대 손대지 않는다.
- **Lead 전용**: `depth === 0` 의 `externalHistory` 에만 적용. Sub-agent 호출 단위는 짧고 한 번 쓰고 버려져서 ROI 0.
- **In-memory only.** FS persistence 없음. `events.jsonl` 에는 적용 사실만 관측용으로 append.

**Out of scope:**
- `cache_edits` beta API integration. (Anthropic provider 전용. Phase 2 candidate.)
- 토큰 카운팅으로 "X tokens 이상이면 강제 compact" — 본 스펙은 시간축만.
- Sub-agent depth>0 history compaction.

---

## 0. 사전 정리: OpenHive 도구 분류

`session.ts:50-60` 의 `TODO_TOOL_NAMES` 와 `mcpTool()` (`session.ts:2083-2095`, `${serverName}__${toolName}` 네이밍) 를 기준으로 두 집합을 정의한다.

### COMPACTABLE (replaceable tool_result content)

읽기 전용이고, 결과가 외부 자원 스냅샷이라 LLM 이 필요하면 다시 호출하면 그만인 도구.

| Tool | 위치 | 비고 |
|---|---|---|
| `web_fetch` | `apps/web/lib/server/tools/webfetch.ts:93` | URL 본문. 식으면 stale. |
| `sql_query` | `session.ts:1537` | 읽기 SQL. 결과는 시점 스냅샷. |
| `read_skill_file` | `session.ts:1743` | 이미 `elideReadSkillFileResults` (line 170-190) 가 부분적으로 처리 중이지만, run_skill_script 가 **안 돌았거나 다른 skill 의 read 였던 경우** 는 그대로 남는다. microcompact 가 보완. |
| `mcp__*` (모든 MCP 도구) | `session.ts:2083-2095` 가 `${serverName}__${toolName}` 형태로 등록 | Notion fetch, Slack 메시지 fetch, Google Drive read 등. 전부 외부 스냅샷. |
| `run_skill_script` | `session.ts:1828` | **단, JSON envelope 안의 `files: [...]` 는 보존** (line 1907 의 `registerSkillArtifacts` 산출물 — 아티팩트 포인터는 이후 턴이 참조). Stdout/stderr 본문만 비운다. |

### NEVER_COMPACT (trajectory / 감사 / 사용자 의사결정 보존)

| Tool | 사유 |
|---|---|
| `delegate_to` (`session.ts:746`) | 델리게이션 결과 = sub-agent 가 산출한 결정/요약. 다시 부른다고 동일 결과 보장 X. trajectory 의 일부. |
| `delegate_parallel` (`session.ts:761`) | 동상. |
| `ask_user` (`session.ts:776`) | 유저 답변. 절대 재현 불가. |
| `set_todos` / `add_todo` / `complete_todo` (`TODO_TOOL_NAMES`, `session.ts:2040`) | 상태 기계. tool_result content 가 비어도 LLM 이 다음 턴에 잘못 추론. |
| `sql_exec` (`session.ts:1555`) | **쓰기 SQL.** 감사 / 디버깅 목적. 결과 (row count, last_insert_rowid) 가 후속 결정에 영향. 보존. |
| `activate_skill` (skill activation tool) | 활성화 사실 자체가 trajectory. SKILL.md 본문은 systemPrompt 쪽이라 무관. 안전하게 보존. |

규칙: **whitelist 방식.** COMPACTABLE 집합에 명시적으로 매칭되지 않으면 손대지 않는다.

---

## Phase 1 — Core: microcompact 모듈

### Task 1.1: 모듈 신설

**Files:**
- Create: `apps/web/lib/server/engine/microcompact.ts`

- [ ] Step 1: 모듈 헤더 docstring — "Time-based microcompact: clear stale tool_result bodies in-place when prefix cache is cold." Claude Code `microCompact.ts` 의 time-based path 를 OpenHive 의 ChatMessage 모델에 맞춰 포팅한 거라고 명시.
- [ ] Step 2: 환경 변수 파싱 헬퍼.

```ts
export const STALE_AFTER_MS = (() => {
  const raw = process.env.OPENHIVE_MICROCOMPACT_STALE_MS
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000 // 5분
})()

export const MICROCOMPACT_DISABLED = process.env.OPENHIVE_MICROCOMPACT_DISABLED === '1'
```

- [ ] Step 3: COMPACTABLE / NEVER_COMPACT 상수.

```ts
const COMPACTABLE_BUILTIN = new Set<string>([
  'web_fetch',
  'sql_query',
  'read_skill_file',
  'run_skill_script', // 특수 처리 — files[] 보존
])

const NEVER_COMPACT = new Set<string>([
  'delegate_to',
  'delegate_parallel',
  'ask_user',
  'set_todos',
  'add_todo',
  'complete_todo',
  'sql_exec',
  'activate_skill',
])

function isCompactable(name: string): boolean {
  if (NEVER_COMPACT.has(name)) return false
  if (COMPACTABLE_BUILTIN.has(name)) return true
  if (name.includes('__')) return true // mcp__server__tool — 모두 compactable
  return false
}
```

- [ ] Step 4: 시그니처 결정.

```ts
export interface MicrocompactResult {
  applied: number
  charsSaved: number
  entries: Array<{ tool_name: string; tool_call_id: string; original_chars: number }>
}

export function maybeMicrocompact(
  history: ChatMessage[],
  now: number = Date.now(),
): MicrocompactResult
```

`history` 는 in-place mutation. caller 는 result 만 받아서 이벤트 emit.

### Task 1.2: 마지막 assistant timestamp 추적

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (state 또는 ChatMessage 확장)

OpenHive `ChatMessage` 에 timestamp 필드가 없다. 두 옵션:

**Option A (선호):** `ChatMessage` 에 optional `_ts?: number` (epoch ms) 추가. `streamTurn` 에서 `history.push({ role: 'assistant', ... })` 할 때 `_ts: Date.now()` 같이 박는다. provider 직렬화에서는 `buildMessages()` (session.ts:629) 가 어차피 OpenAI shape 으로 변환하므로 `_ts` 는 자연스럽게 누락 → 외부로 새지 않음.

**Option B:** `state().lastAssistantTs: Map<sessionId, number>` 추가. 침투 적지만 외부 history (caller-provided) 에는 안 잡힘.

→ **A 채택.** caller 가 reattach 시 history 를 재구성해도 `_ts` 가 없으면 "오래됐다"로 간주하면 안전 fallback.

- [ ] Step 1: `apps/web/lib/server/engine/types.ts` (또는 ChatMessage 정의된 곳) 에 `_ts?: number` 추가. `// internal — never serialized to provider` 주석.
- [ ] Step 2: `buildMessages()` 가 `_ts` 를 떨어뜨리는지 확인. 필요하면 명시적으로 strip (`{ role, content, tool_calls, tool_call_id }` 만 pass).
- [ ] Step 3: `streamTurn` 안의 `history.push({ role: 'assistant', ... })` (session.ts:707) 에 `_ts: Date.now()` 추가.
- [ ] Step 4: 동일하게 `applyResult` (line 849) 의 `history.push({ role: 'tool', ... })` 도 `_ts: Date.now()`.
- [ ] Step 5: `runDelegation` / `runAskUser` 등 history 에 메시지를 직접 append 하는 모든 경로 찾아 `_ts` 채우기. (grep `history.push` in session.ts.)

### Task 1.3: `maybeMicrocompact` 본체

**Files:**
- Modify: `apps/web/lib/server/engine/microcompact.ts`

- [ ] Step 1: disabled / 빈 history early-return.

```ts
if (MICROCOMPACT_DISABLED) return { applied: 0, charsSaved: 0, entries: [] }
if (history.length === 0) return { applied: 0, charsSaved: 0, entries: [] }
```

- [ ] Step 2: 마지막 assistant 메시지 ts 찾기. 없으면 (legacy) → `lastTs = 0` (즉 "오래됨"으로 간주).

```ts
let lastTs = 0
for (let i = history.length - 1; i >= 0; i--) {
  const m = history[i]
  if (m.role === 'assistant' && typeof m._ts === 'number') {
    lastTs = m._ts
    break
  }
}
const age = now - lastTs
if (age < STALE_AFTER_MS) {
  return { applied: 0, charsSaved: 0, entries: [] } // cache hot — no-op
}
```

- [ ] Step 3: `tool_call_id → tool_name` 매핑 (assistant 메시지의 `tool_calls` 순회). `elideReadSkillFileResults` (session.ts:170) 가 쓰는 `indexToolCalls` 헬퍼 그대로 import 해서 재사용.
- [ ] Step 4: history 순회하며 `role === 'tool'` 인 메시지에 대해:
  1. `tool_name = meta.get(m.tool_call_id)?.name` 결정.
  2. `isCompactable(tool_name)` false → skip.
  3. content 가 이미 `[Old tool result cleared` 로 시작 (멱등) → skip.
  4. content 가 string 이 아니거나 매우 짧으면 (e.g. <200 chars) skip — ROI 없음. threshold 도 env 화 (`OPENHIVE_MICROCOMPACT_MIN_CHARS`, default 200).
  5. **`run_skill_script` 특수 처리**: content 를 `JSON.parse` 시도, 실패하면 평범한 envelope 아님 → 일반 clear. 성공하고 `parsed.files` 가 array 면:
     - `files` 항목들의 `name` 만 추려서 csv 화.
     - 새 content = JSON envelope 으로 재구성:
       ```ts
       JSON.stringify({
         ok: parsed.ok,
         files: parsed.files,
         _cleared: `stdout/stderr cleared (${original.length} chars). Re-run if needed.`,
       })
       ```
     - 즉 `files` 는 **그대로 보존**, stdout/stderr 만 증발.
  6. **일반 케이스**: replacement 문자열.
     ```ts
     const filesCsv = extractFileNamesIfAny(content) // 다른 envelope 도 files 보존 시도
     m.content = `[Old tool result cleared. Tool: ${toolName}. ${filesCsv ? `Files: ${filesCsv}. ` : ''}Re-call if needed.]`
     ```
- [ ] Step 5: 각 mutation 마다 `entries.push({ tool_name, tool_call_id, original_chars })`, `charsSaved += original.length - m.content.length`, `applied += 1`.
- [ ] Step 6: return `{ applied, charsSaved, entries }`.

---

## Phase 2 — Wiring: streamTurn 진입점

### Task 2.1: 호출 지점 결정

`session.ts:627-630`:
```ts
async function* streamTurn(opts: StreamTurnOpts): AsyncGenerator<Event> {
  const { sessionId, team, node, systemPrompt, history, tools, depth } = opts
  const messages = buildMessages(systemPrompt, history)
```

`buildMessages` 호출 **직전**, 즉 line 628 과 629 사이가 정확한 삽입 지점. history mutation 이 messages 에 반영되어야 하므로 buildMessages 이전이어야 한다.

대안: outer loop (`streamTurn` caller) 의 `compactHistory` 호출 부근 (session.ts:577-583) 에 둘 수도 있지만, 거기는 finite window 일 때만 실행. microcompact 는 항상 evaluate 해야 하므로 streamTurn 안이 맞다.

### Task 2.2: 호출 + 이벤트 emit

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts`

- [ ] Step 1: import 추가.
```ts
import { maybeMicrocompact } from './microcompact'
```

- [ ] Step 2: `streamTurn` 본체 line 628 직후, 629 직전에 삽입.

```ts
// Time-based microcompact: clear stale read-only tool_result bodies before
// the prompt is built. Only applies to Lead (depth === 0); sub-agent
// histories are short and ephemeral. No-op if last assistant turn is still
// within STALE_AFTER_MS (cache hot).
if (depth === 0) {
  const mc = maybeMicrocompact(history)
  for (const e of mc.entries) {
    yield makeEvent(
      'microcompact.applied',
      sessionId,
      {
        tool_name: e.tool_name,
        tool_call_id: e.tool_call_id,
        original_chars: e.original_chars,
      },
      { depth, node_id: node.id, tool_call_id: e.tool_call_id, tool_name: e.tool_name },
    )
  }
}

const messages = buildMessages(systemPrompt, history)
```

- [ ] Step 3: `historyChars` 누적 계산 (session.ts:637-642) 은 이미 mutate 된 history 를 본다 — 자연스럽게 줄어든 값이 usage 메트릭에 반영. 별도 작업 없음.

### Task 2.3: 이벤트 타입 등록

**Files:**
- Modify: `apps/web/lib/server/engine/events.ts` (혹은 Event 타입 정의된 곳)
- Modify: events.jsonl 스키마 문서 (있다면 — 없으면 skip)

- [ ] Step 1: Event union 에 `'microcompact.applied'` kind 추가. data shape: `{ tool_name: string, tool_call_id: string, original_chars: number }`.
- [ ] Step 2: events.jsonl writer 가 unknown kind 를 drop 하는지 확인 — 만약 그렇다면 화이트리스트에 추가.
- [ ] Step 3: SSE relay (앱 레이어) 가 unknown event 를 통과시키는지 확인. Run 캔버스가 처리 못 해도 무시되어야 (시각화 옵션).

### Task 2.4: Lead-only 가드 검증

`runDelegation` 이 sub-agent run 을 띄울 때 어떤 history 를 넘기는지 확인 (session.ts 의 delegation 헬퍼). depth > 0 면 microcompact 자체가 no-op 이므로 어떤 history 가 들어와도 안전하지만, **명시적으로 가드** (`if (depth === 0)`) 가 위에 있으니 OK. assertion 추가 불필요.

---

## Phase 3 — 관찰성 + 테스트

### Task 3.1: usage.json 통계 (선택)

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` `recordUsage` 호출부

- [ ] Step 1: `recordUsage` payload 에 `microcompactApplied`, `microcompactCharsSaved` optional 필드 추가. 한 turn 누적값을 변수로 들고 있다가 usage 이벤트에서 같이 기록. (`mc.applied`, `mc.charsSaved` 를 streamTurn 스코프 변수에 저장.)
- [ ] Step 2: 누적 안 해도 됨 — 부담 크면 events.jsonl 만으로 충분. 후속 작업에 분류.

### Task 3.2: 단위 테스트

**Files:**
- Create: `apps/web/lib/server/engine/microcompact.test.ts`

- [ ] Step 1: 케이스 A — assistant `_ts` 가 6분 전, history 에 `web_fetch` tool result 1개. 호출 → applied=1, content 가 `[Old tool result cleared. Tool: web_fetch. Re-call if needed.]`.
- [ ] Step 2: 케이스 B — assistant `_ts` 가 1분 전 (STALE_AFTER_MS 미만). 호출 → applied=0, content 무변화.
- [ ] Step 3: 케이스 C — `delegate_to` tool result, 6분 경과. applied=0 (NEVER_COMPACT).
- [ ] Step 4: 케이스 D — `mcp__notion__notion-search` tool result, 6분 경과. applied=1 (mcp 자동 compactable).
- [ ] Step 5: 케이스 E — `run_skill_script` 결과가 `{ ok: true, stdout: "...long...", files: [{name:'a.csv', path:'...'}] }`. 6분 경과. applied=1, 새 content 를 JSON.parse 했을 때 `parsed.files` 길이 1, `parsed.stdout` 부재 또는 `_cleared` 마커 있음.
- [ ] Step 6: 케이스 F — `OPENHIVE_MICROCOMPACT_DISABLED=1`. applied=0 강제.
- [ ] Step 7: 케이스 G — 멱등성: 같은 history 두 번 호출 → 두 번째는 applied=0 (이미 `[Old tool result cleared` prefix).
- [ ] Step 8: 케이스 H — `_ts` 가 전혀 없는 legacy history (reattach 시뮬). lastTs=0 으로 처리되어 모든 compactable 비움.
- [ ] Step 9: 케이스 I — `sql_exec` 결과는 보존. `sql_query` 결과는 비워짐.

### Task 3.3: 통합 / 수동 검증

- [ ] Step 1: dev 서버 기동 (`pnpm --filter @openhive/web dev`).
- [ ] Step 2: Lead 가 MCP `notion-search` 를 한 번 호출하는 시나리오 실행.
- [ ] Step 3: 6분 idle 대기 후 같은 세션에 `ask_user` 답으로 후속 턴 트리거.
- [ ] Step 4: `~/.openhive/sessions/{id}/events.jsonl` 에 `microcompact.applied` 라인이 mcp tool 에 대해 떠야 함.
- [ ] Step 5: 같은 events.jsonl 에서 그 이전의 `delegate_to` tool_result 는 무변화 (동일 세션이라면).
- [ ] Step 6: 다음 턴 provider request body 캡처 (브레이크포인트 또는 console.log) — 해당 mcp tool message content 가 placeholder 인지 확인.
- [ ] Step 7: `STALE_AFTER_MS=1000` 으로 재현 빠르게 — 1초만 기다려도 trigger.

---

## Phase 4 — 문서

### Task 4.1: CLAUDE.md 업데이트

**Files:**
- Modify: `CLAUDE.md`

- [ ] Step 1: "Architectural Rules" 인근에 한 줄 — "Lead history 의 stale read-only tool_result 는 `STALE_AFTER_MS` 경과 시 microcompact 가 in-place 비움. trajectory 도구 (`delegate_to`, `ask_user`, todo) 는 절대 보존."
- [ ] Step 2: env 변수 표가 있다면 `OPENHIVE_MICROCOMPACT_STALE_MS`, `OPENHIVE_MICROCOMPACT_DISABLED`, `OPENHIVE_MICROCOMPACT_MIN_CHARS` 추가.

### Task 4.2: 다이어그램

해당 없음. 엔진 플로우 / 델리게이션 / 이벤트 구조 / 저장 레이아웃 변경 아님 (history mutation 은 in-memory tactical optimization). CLAUDE.md 다이어그램 규칙에 따라 skip.

---

## 리스크 / 주의

- **Cache 깨짐 위험**: `STALE_AFTER_MS` 가 provider TTL 보다 짧으면 hot cache 를 깬다. Anthropic 5min ephemeral cache 와 동일하게 default 5분으로 맞춤. 더 짧게 튜닝하려면 명시적으로 env 로.
- **legacy history (no `_ts`)**: reattach 직후 첫 turn 에 한꺼번에 비워질 수 있음. 의도된 동작 — reattach 자체가 "오래된 세션" 신호. 다만 user 가 재접속 직후 즉시 후속 행동을 한다면 `_ts` 누락은 피해야 함. → reattach 경로에서 `_ts = Date.now()` 로 backfill 하는 옵션 검토 (Task 1.2 Step 2 의 strip 정책과 충돌하지 않는 선에서; 일단은 보수적으로 비워지게 둔다 — 정확성에 영향 없음, 비용만 더 든다).
- **MCP tool 중 비대해서 보존하고 싶은 게 있을 수 있음**: 현재는 `__` 만 보면 무조건 compactable. 만약 특정 MCP 도구 (예: `mcp__notion__notion-create-pages` — 쓰기 작업, 결과에 page id 가 든다) 가 trajectory 면 NEVER_COMPACT 에 individually 추가. 1차에는 단순화 — 모든 mcp 비움, 보존 필요한 case 발견되면 case-by-case.
- **`run_skill_script` JSON envelope 가 미래에 바뀌면**: `files: []` 보존 로직이 silently 깨질 수 있음. test E 가 가드. envelope shape 변경 시 microcompact 도 같이 보고.
- **`elideReadSkillFileResults` 와의 중복**: `read_skill_file` 이 두 패스에서 다 처리됨. 멱등성 (Step 7) 이 보장되므로 안전. 다만 elide 가 먼저 돌아 `<elided: ...>` 로 바꿔두면 microcompact 의 `<200 chars` 가드에 걸려 자연스럽게 skip — OK.
- **Sub-agent 계산 누락**: depth>0 에서 동일 ROI 가 나올 케이스 (예: Lead 가 거대 sub-team 을 계속 부르는 경우) 는 이번 스펙 밖. 후속에서 measure 후 결정.

---

## Definition of Done

- [ ] `apps/web/lib/server/engine/microcompact.ts` 신설 + 모든 unit test 통과 (Task 3.2 A–I).
- [ ] `streamTurn` (session.ts:627-) 가 depth=0 에서 `maybeMicrocompact` 호출, 결과를 `microcompact.applied` 이벤트로 emit.
- [ ] `ChatMessage._ts` 추가 + 모든 `history.push` 경로에 timestamp 박힘.
- [ ] `OPENHIVE_MICROCOMPACT_DISABLED=1` 로 완전 비활성화 가능.
- [ ] 6분 idle 후 후속 턴: MCP / web_fetch / sql_query tool_result content 는 placeholder, delegate_to / ask_user / todo / sql_exec 는 원문 유지, `run_skill_script` envelope 의 `files` 배열은 살아남음.
- [ ] `biome check` clean, `pnpm --filter @openhive/web test` 통과.
- [ ] 새 deps 0개. FS persistence 0개. LangChain/LangGraph 재도입 0건.
