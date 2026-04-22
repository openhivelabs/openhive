# S1 — Subagent 결과 100KB Cap + 요약

> **ADDENDUM (lock-in, 2026-04-22) — plan.md §2, §4 우선.**
> 1. **단위는 char.** S1 의 모든 임계값은 chars (`MAX_CHILD_RESULT_CHARS=100_000`, `SUMMARY_MAX_CHARS=4_000`). A4 token 으로 전환은 v2 (별도 plan).
> 2. **Hook 위치 확정.** `apps/web/lib/server/engine/session.ts:1112` 의 single-delegation 성공 분기 `delegation_closed` emit 직전. **parallel (`session.ts:1310`) 은 본 라운드에서 cap 적용 안 함** — S3 fork 의 결과 merge 자리와 충돌. 후속 PR 에서 처리.
> 3. **`AgentSpec.result_cap?` 추가 위치 확정.** `apps/web/lib/server/engine/team.ts:12` AgentSpec 끝 + `:67` toAgentSpec passthrough (plan §4.7).
> 4. **이벤트 변경 없음** — `delegation_closed.data` 만 optional 필드 확장 (forward-compatible). plan §5 의 일괄 union 업데이트에서 주석으로 문서화.

---


**Goal:** Sub-agent (`runDelegation`) 가 부모 (보통 Lead) 에게 돌려주는 `delegation_closed.data.result` 를 **고정 상한 (100,000 chars)** 으로 자르고, 초과 시 **요약본**으로 대체한다. `artifact_paths` / `error` / 구조화 envelope 같은 "버리면 안 되는 신호" 는 항상 보존.

**Why:**
- 현재 `apps/web/lib/server/engine/session.ts:1083-1120` 에서 자식 노드의 `node_finished.data.output` 을 통째로 `delegation_closed.data.result` 에 박아 부모 history 의 `tool_result` 로 주입한다 (캐퍼 없음).
- 자식이 50 페이지 보고서 본문이나 raw HTML dump 를 뱉으면 Lead 의 next-turn input 이 즉시 100K~수백 K 토큰으로 폭주 — context window 사망 + provider rate-limit + Lead 의 후속 판단 품질 저하.
- Claude Code 는 이 문제를 `tools/AgentTool/runAgent.ts` 에서 **100,000 char hard cap** + "Claude summarises the agent's findings" 패턴으로 해결 (`agent.md` 문서화). OpenHive 도 동일 패턴이 필요.
- Per-node provider/model 모델을 깨면 안 되므로 (CLAUDE.md "Per-node provider + model"), 요약 LLM 은 **자식 노드의 provider/model** 을 기본 재사용하고, 옵션 `llm` 전략에서만 별도 small-model fallback.

---

## Architecture

```
runNode (자식)
  └─ 마지막 node_finished.data.output = subOutput (raw, 무제한)

runDelegation (부모 쪽 호출자)
  ├─ subOutput 수집 (현재 코드)
  ├─ ★ NEW: capAndSummarise(subOutput, { node, strategy, signals })
  │     ├─ size ≤ MAX_CHILD_RESULT_CHARS  → passthrough
  │     ├─ size >  MAX_CHILD_RESULT_CHARS → strategy 분기
  │     │     ├─ 'heuristic' (default): head500 + tail200 + extracted artifact paths
  │     │     └─ 'llm': forked summariser call (자식 provider/model 재사용 또는 small-model)
  │     └─ 항상 보존: artifact_paths, error, 구조화 envelope ({ok, files, warnings, ...})
  └─ delegation_closed.data = { result, truncated?, original_chars?, summary_strategy?, artifact_paths? }
```

상한과 전략은 모두 **단일 모듈** `apps/web/lib/server/engine/result-cap.ts` (신규) 에 isolate. `runDelegation` 은 한 줄만 추가.

---

## 상수 / 환경변수

`apps/web/lib/server/engine/result-cap.ts` 상단에 export:

```ts
export const MAX_CHILD_RESULT_CHARS = 100_000   // hard cap (Claude Code parity)
export const SUMMARY_MAX_CHARS = 4_000          // 요약 본문 목표 길이
export const HEAD_KEEP_CHARS = 500              // heuristic head 보존
export const TAIL_KEEP_CHARS = 200              // heuristic tail 보존
export const ARTIFACT_PATH_LIMIT = 32           // 추출할 path 최대 개수
```

환경변수 (런타임 override, per-node YAML 보다 우선순위 낮음):

| 변수 | 값 | 기본 | 역할 |
|---|---|---|---|
| `OPENHIVE_RESULT_SUMMARY_STRATEGY` | `heuristic` \| `llm` \| `off` | `heuristic` | 전역 디폴트 전략 |
| `OPENHIVE_RESULT_MAX_CHARS` | int | `100000` | cap override (테스트/디버그용) |
| `OPENHIVE_RESULT_SUMMARY_MODEL` | provider:model | (없음) | `llm` 전략 시 fallback 모델 (예: `copilot:gpt-4o-mini`) |

per-node YAML (`agent` 블록 안):

```yaml
# companies/{c}/teams/{t}.yaml — agents[*]
result_cap:
  strategy: llm           # 'heuristic' | 'llm' | 'off' — off 은 cap 만, 요약 안 함 (잘림)
  max_chars: 80000        # optional override
```

`off` 모드는 여전히 cap 자체는 적용 (잘리지만 요약 LLM 호출 안 함). 디버그용.

---

## Phase 1 — 코어 cap + heuristic 요약

### Task 1.1: `result-cap.ts` 신규 모듈

**Files:**
- Create: `apps/web/lib/server/engine/result-cap.ts`

- [ ] Step 1: 위 상수 export.
- [ ] Step 2: 타입 정의:

```ts
export type SummaryStrategy = 'heuristic' | 'llm' | 'off'

export interface CapInput {
  raw: string
  node: AgentSpec               // 자식 노드 — provider/model 추출용
  sessionId: string
  toolCallId: string
  strategy: SummaryStrategy
  maxChars: number
}

export interface CapResult {
  result: string                // 부모에게 돌려줄 최종 문자열
  truncated: boolean
  originalChars: number
  summaryStrategy: SummaryStrategy | 'passthrough'
  artifactPaths: string[]       // 추출되거나 envelope 에서 발견된 path
}
```

- [ ] Step 3: `extractArtifactPaths(raw: string): string[]` — 정규식으로 다음 패턴 수집 (중복 제거, `ARTIFACT_PATH_LIMIT` 상한):
  - `~/.openhive/sessions/...` 경로
  - `/.../artifacts/...` 절대경로 (`artifacts/` 디렉토리 마커 포함)
  - `*.{md,pdf,csv,json,html,txt,xlsx,docx}` 확장자가 따라붙는 경로 토큰
  - JSON envelope `{ "files": [...] }` 안의 `path` / `name` 필드 — `JSON.parse` 시도하고 실패하면 정규식 `"path"\s*:\s*"([^"]+)"` fallback
- [ ] Step 4: `detectStructuredEnvelope(raw): { ok?: boolean; files?: unknown[]; warnings?: unknown[]; error?: unknown } | null` — `raw.trim()` 이 `{` 로 시작하면 `JSON.parse` 시도. 실패는 `null`. 성공 + 키 한 개 이상 매치하면 envelope 으로 인정.
- [ ] Step 5: `heuristicSummary(raw, paths, envelope): string` — 다음 형식 반환:

```ts
const head = raw.slice(0, HEAD_KEEP_CHARS)
const tail = raw.slice(-TAIL_KEEP_CHARS)
return [
  `[truncated subagent output: original ${raw.length.toLocaleString()} chars, kept head/tail + artifact refs]`,
  '',
  '--- head ---',
  head,
  '',
  '--- tail ---',
  tail,
  paths.length > 0 ? `\n--- artifacts (${paths.length}) ---\n${paths.join('\n')}` : '',
  envelope ? `\n--- envelope keys ---\n${Object.keys(envelope).join(', ')}` : '',
].filter(Boolean).join('\n')
```

- [ ] Step 6: 메인 export `capAndSummarise(input: CapInput): Promise<CapResult>`:
  1. `originalChars = input.raw.length`
  2. `paths = extractArtifactPaths(input.raw)`
  3. `envelope = detectStructuredEnvelope(input.raw)`
  4. **Passthrough 조건**: `originalChars <= input.maxChars` → `{ result: raw, truncated: false, originalChars, summaryStrategy: 'passthrough', artifactPaths: paths }`
  5. **Envelope 보존 조건**: envelope 가 있고 직렬화 길이가 `input.maxChars` 이하면 envelope 을 `JSON.stringify(envelope, null, 2)` 로 직렬화해서 그대로 사용 (skill `{ok, files, warnings}` 포맷이 LLM 에게 더 유용 — 자르지 말 것).
  6. **Strategy 분기**:
     - `'off'` → `raw.slice(0, input.maxChars) + '\n[truncated — summarisation off]'`
     - `'heuristic'` → `heuristicSummary(raw, paths, envelope)`
     - `'llm'` → `await llmSummary(input, paths, envelope)` (Task 2.1). 실패 시 `heuristicSummary` 로 fallback + `console.warn`.
  7. 모든 경우 `truncated: true`, `summaryStrategy: <선택된 전략>`, `artifactPaths: paths` 반환.

- [ ] Step 7: 단위 테스트 `apps/web/lib/server/engine/result-cap.test.ts`:
  - 50KB → passthrough
  - 200KB plain text → heuristic, head/tail 둘 다 포함, `originalChars=200000`
  - 12KB JSON envelope `{ok:true, files:[...]}` → 직렬화 길이 ≤ cap 이면 envelope 보존
  - 200KB 안에 `~/.openhive/sessions/abc/artifacts/report.pdf` 포함 → `artifactPaths` 에 등장
  - `strategy: 'off'` → 자른 후 marker 줄 추가, 요약 LLM 호출 없음 (mock 으로 검증)

### Task 1.2: `runDelegation` 에 cap 훅 삽입

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (lines 992-1121)

- [ ] Step 1: 파일 상단 import 추가:

```ts
import { capAndSummarise, MAX_CHILD_RESULT_CHARS, type SummaryStrategy } from './result-cap'
```

- [ ] Step 2: `runDelegation` 의 happy-path `delegation_closed` (현재 1111-1120 라인) 직전에 cap 훅 삽입:

```ts
// ★ S1: cap + summarise sub-agent output before injecting into parent history.
//   Without this a 200KB report body kills the Lead's context window.
const strategy: SummaryStrategy =
  (target.result_cap?.strategy as SummaryStrategy | undefined) ??
  (process.env.OPENHIVE_RESULT_SUMMARY_STRATEGY as SummaryStrategy | undefined) ??
  'heuristic'
const maxChars =
  target.result_cap?.max_chars ??
  Number(process.env.OPENHIVE_RESULT_MAX_CHARS) ||
  MAX_CHILD_RESULT_CHARS

const capped = await capAndSummarise({
  raw: subOutput,
  node: target,
  sessionId,
  toolCallId,
  strategy,
  maxChars,
})

yield makeEvent(
  'delegation_closed',
  sessionId,
  {
    assignee_id: target.id,
    assignee_role: target.role,
    result: capped.result,
    ...(capped.truncated && {
      truncated: true,
      original_chars: capped.originalChars,
      summary_strategy: capped.summaryStrategy,
    }),
    ...(capped.artifactPaths.length > 0 && { artifact_paths: capped.artifactPaths }),
  },
  { depth, node_id: fromNode.id, tool_call_id: toolCallId },
)
```

- [ ] Step 3: 에러 분기 (1088-1108 의 `catch` 블록) 는 **건드리지 않음** — error message 는 항상 짧고 사용자 신호이므로 cap 대상 아님. 단, `result` 필드에 `error: true` 가 함께 있으면 보존되는지 회귀 테스트.
- [ ] Step 4: `AgentSpec` 타입에 optional `result_cap` 추가:

`apps/web/lib/server/team.ts` (또는 `AgentSpec` 정의 파일 — `grep -n "interface AgentSpec\|type AgentSpec" apps/web/lib/server/`):

```ts
export interface AgentResultCapConfig {
  strategy?: 'heuristic' | 'llm' | 'off'
  max_chars?: number
}

// AgentSpec 안:
result_cap?: AgentResultCapConfig
```

- [ ] Step 5: YAML 파서 (team spec loader) 가 `result_cap` 블록을 그대로 통과시키는지 확인. 별도 검증은 minimal — 잘못된 값은 런타임에서 fallback.

### Task 1.3: 이벤트 스키마 / 타입 보강

**Files:**
- Modify: `apps/web/lib/server/events/schema.ts`

- [ ] Step 1: `EventKind` 는 변경 안 함 — `delegation_closed` 의 `data` 만 확장. 이벤트 타입 자체를 추가하지 않는 이유: timeline UI / SSE consumer 가 신규 kind 를 무시하면 silent drop. 기존 kind 의 data 확장은 forward-compatible.
- [ ] Step 2: 파일 상단 코멘트 (또는 별도 d.ts) 에 `delegation_closed.data` 의 새 optional 필드 문서화:

```ts
/**
 * delegation_closed.data:
 *   - assignee_id, assignee_role, result (always)
 *   - error?: boolean
 *   - truncated?: boolean              // S1
 *   - original_chars?: number          // S1 — pre-cap length
 *   - summary_strategy?: 'heuristic' | 'llm' | 'off' | 'passthrough'
 *   - artifact_paths?: string[]        // S1 — extracted artifact references
 */
```

- [ ] Step 3: Timeline / Run canvas UI (`apps/web/components/run/...` 트리) 가 `truncated` 표시할 수 있도록 props 통과만 확보. 실제 표시 UI 는 Task 3.1.

---

## Phase 2 — 옵션 LLM 전략

### Task 2.1: `llmSummary` 구현

**Files:**
- Modify: `apps/web/lib/server/engine/result-cap.ts`

- [ ] Step 1: `import { stream as providerStream, buildMessages } from './providers'` 추가 (`providers.ts:21` 의 `stream` 함수 그대로 재사용 — 새 abstraction 만들지 말 것).
- [ ] Step 2: 모델 선택 로직:

```ts
function pickSummaryModel(node: AgentSpec): { providerId: string; model: string } {
  // 1순위: env override (예: copilot:gpt-4o-mini)
  const override = process.env.OPENHIVE_RESULT_SUMMARY_MODEL
  if (override?.includes(':')) {
    const [providerId, ...rest] = override.split(':')
    return { providerId: providerId!, model: rest.join(':') }
  }
  // 2순위: 자식 노드의 provider/model 그대로 — per-node 원칙 유지
  return { providerId: node.provider_id, model: node.model }
}
```

- [ ] Step 3: 프롬프트 템플릿 (English; LLM 입력이라 i18n 안 함):

```ts
const SUMMARY_SYSTEM = `You compress a sub-agent's verbose output for its parent agent.
The parent will read your summary as the sub-agent's reply, so write in third person ("the sub-agent ...").

HARD RULES:
- Output strictly under ${SUMMARY_MAX_CHARS} characters.
- Preserve every file path, URL, identifier, and numeric figure verbatim.
- Preserve any error messages verbatim.
- If a structured result envelope (JSON with keys like ok/files/warnings) appears, restate its key fields.
- Lead with a 1-sentence verdict: did the sub-agent succeed, partially succeed, or fail?
- Then bullet the concrete deliverables (artifacts, decisions, numbers).
- Then list any unresolved issues / follow-ups.
- Do NOT invent information not present in the input.`

const SUMMARY_USER = (raw: string, paths: string[]) =>
  `Sub-agent raw output (${raw.length.toLocaleString()} chars):\n` +
  `--- BEGIN OUTPUT ---\n${raw}\n--- END OUTPUT ---\n\n` +
  (paths.length > 0
    ? `Detected artifact references (preserve these in your summary):\n${paths.join('\n')}\n`
    : '')
```

- [ ] Step 4: `llmSummary` 본문:

```ts
async function llmSummary(input: CapInput, paths: string[], _env: unknown): Promise<string> {
  const { providerId, model } = pickSummaryModel(input.node)
  const messages = buildMessages(SUMMARY_SYSTEM, [
    { role: 'user', content: SUMMARY_USER(input.raw, paths) },
  ])
  let collected = ''
  const deadline = Date.now() + 30_000  // 30s hard wall
  for await (const delta of providerStream(providerId, model, messages, undefined)) {
    if (Date.now() > deadline) break
    if (delta.kind === 'text' && typeof delta.text === 'string') {
      collected += delta.text
      if (collected.length > SUMMARY_MAX_CHARS * 1.5) break  // runaway guard
    }
    if (delta.kind === 'stop') break
  }
  const trimmed = collected.trim()
  if (!trimmed) throw new Error('llmSummary returned empty')
  // 후처리: 모델이 약속을 어겨 SUMMARY_MAX_CHARS 초과하면 hard slice
  if (trimmed.length > SUMMARY_MAX_CHARS) {
    return trimmed.slice(0, SUMMARY_MAX_CHARS) + '\n[summary truncated to char limit]'
  }
  return trimmed
}
```

- [ ] Step 5: `capAndSummarise` 의 `'llm'` 분기에서 `try/catch` 로 감싸 실패 시 `heuristicSummary` 로 fallback + 이벤트 `summary_strategy: 'heuristic'` 로 마킹 (사용자가 LLM 실패를 timeline 에서 식별 가능하도록 `console.warn('[result-cap] llm summary failed, fell back to heuristic:', err)`).

### Task 2.2: 실패/타임아웃 회귀 테스트

**Files:**
- Modify: `apps/web/lib/server/engine/result-cap.test.ts`

- [ ] Step 1: `providers.stream` 을 mock — text delta 한 개만 yield 후 stop → `summary_strategy: 'llm'` + 결과 길이 ≤ `SUMMARY_MAX_CHARS`.
- [ ] Step 2: mock 이 throw → `summary_strategy: 'heuristic'` 로 fallback, `truncated: true` 유지.
- [ ] Step 3: mock 이 영원히 yield (deadline 30s) → 테스트에서는 `vi.useFakeTimers()` + 짧은 deadline override 로 검증. (deadline 을 상수로 빼서 테스트에서 주입 가능하게.)

---

## Phase 3 — UI / 관측성

### Task 3.1: Timeline 에 truncated 배지

**Files:**
- Modify: `apps/web/components/run/Timeline.tsx` (또는 `delegation_closed` 를 렌더하는 컴포넌트 — `grep -rn "delegation_closed" apps/web/components` 로 확정)
- Modify: `apps/web/lib/i18n.ts`

- [ ] Step 1: `delegation_closed` row 에서 `event.data.truncated === true` 일 때 작은 배지 표시: `[t('timeline.delegation.truncated', { original: original_chars.toLocaleString() })]`.
- [ ] Step 2: hover/click 시 `summary_strategy` + `artifact_paths.length` 노출 (기존 detail panel 패턴 그대로).
- [ ] Step 3: `i18n.ts` 의 `en` / `ko` 사전에 키 추가:

```ts
// en
'timeline.delegation.truncated': 'Output capped ({original} chars → summary)',
'timeline.delegation.summaryStrategy': 'Summary: {strategy}',
'timeline.delegation.artifactCount': '{count} artifact(s) preserved',

// ko
'timeline.delegation.truncated': '출력 잘림 ({original}자 → 요약)',
'timeline.delegation.summaryStrategy': '요약 방식: {strategy}',
'timeline.delegation.artifactCount': '아티팩트 {count}개 보존됨',
```

- [ ] Step 4: 한국어 번역이 직역체 아닌지 셀프체크 — "truncated" 를 "절단됨" 같은 번역기체 대신 "잘림" 사용.

### Task 3.2: `OPENHIVE_DEBUG_RESULT_CAP` 로깅

**Files:**
- Modify: `apps/web/lib/server/engine/result-cap.ts`

- [ ] Step 1: env `OPENHIVE_DEBUG_RESULT_CAP=1` 일 때 `capAndSummarise` 가 `console.log` 로 한 줄 요약 출력:

```
[result-cap] node=researcher#abc strategy=heuristic original=204812 → 1183 chars, paths=3
```

- [ ] Step 2: 프로덕션 noise 없도록 default off.

---

## 보존 규칙 (Test Plan 의 근거)

cap 후에도 **반드시 살아있어야 하는 것**:

1. **`artifact_paths`** — `delegation_closed.data.artifact_paths` 로 별도 export. Lead 가 요약본에서 path 가 잘려도 이 필드로 재참조 가능.
2. **`error` 필드** — error path 는 cap 우회 (Task 1.2 Step 3).
3. **`tool_call_id` / `node_id` / `depth`** — 기존 `makeEvent` opts 그대로 통과. 변경 없음.
4. **구조화 envelope** — skill `{ok, files, warnings}` 가 cap 이하면 verbatim. 초과 시 envelope 키 목록은 heuristic summary 안에 포함.
5. **사용자 노출 텍스트** — 영어 marker (`--- head ---`, `[truncated subagent output: ...]`) 는 LLM 입력 전용이라 i18n 대상 아님. UI 배지만 i18n.

---

## Test Plan

`apps/web/lib/server/engine/result-cap.test.ts` + `session.test.ts` 회귀:

- [ ] **Case A — passthrough**: 50KB plain text output → `delegation_closed.data` 에 `truncated` 없음, `result` 길이 = 원본.
- [ ] **Case B — heuristic 요약**: 200KB output → `truncated: true`, `original_chars: 200000`, `summary_strategy: 'heuristic'`, `result` 안에 head 500자 + tail 200자 모두 포함, 길이 ≤ ~6KB.
- [ ] **Case C — artifact path 생존**: 200KB 본문 중간에 `~/.openhive/sessions/sess-1/artifacts/report.pdf` 한 줄 → cap 후 `delegation_closed.data.artifact_paths` 에 정확히 등장.
- [ ] **Case D — envelope 보존**: 12KB JSON `{"ok":true,"files":[{"path":"a.md"}]}` → `result` 가 `JSON.parse` 가능, `ok` 와 `files` 둘 다 살아있음.
- [ ] **Case E — error 우회**: `runDelegation` 의 catch 분기 hit → `result` 에 `errors.renderError(...)` 메시지 그대로, cap 무관. `truncated` 필드 없음.
- [ ] **Case F — LLM strategy fallback**: provider stream mock throw → `summary_strategy: 'heuristic'`, run 은 정상 진행.
- [ ] **Case G — `off` 전략**: per-node `result_cap.strategy: 'off'` + 200KB → `result` 길이 = `MAX_CHILD_RESULT_CHARS`, `summary_strategy: 'off'`, marker 줄 포함.
- [ ] **Case H — env override**: `OPENHIVE_RESULT_MAX_CHARS=10000` 으로 11KB output → `truncated: true` (cap override 가 먹는지).
- [ ] **수동 E2E**: 회사 하나 만들고 `researcher` 에이전트한테 "raw HTML 5만 단어 dump 해줘" 요청 → Lead 의 next-turn input token 이 cap 적용 전 대비 90%+ 감소하는지 `events.jsonl` 의 `usage` 필드로 확인.

---

## 비범위 (다음 스펙들)

- **History sliding-window 압축** — Lead 본인의 누적 history 컴팩션은 S2 (`s2-microcompact.md`) 책임. S1 은 sub-agent → parent 1회성 주입만.
- **Token 기반 cap** — 현재는 char 기반 (deterministic, provider-agnostic). 토큰 카운터는 A4 이후 옵션으로 도입.
- **Parallel delegation 결과 합산 cap** — `delegate_parallel` 의 N-way 결과 합산 cap 은 S3 와 함께 다룸. S1 은 1:1 델리게이션만.
- **요약 결과 캐싱** — 같은 raw 가 두 번 들어올 일 거의 없음 (sub-agent 출력은 unique). 캐시 미도입.

---

## 리스크 / 주의

- **요약 LLM 실패 silent fallback**: `llm` 전략 선택했는데 매번 fallback 되면 사용자가 모를 수 있음. Task 3.1 의 timeline 배지에 `summary_strategy: 'heuristic'` 가 보이므로 식별 가능. 추가로 `console.warn` 한 줄.
- **Envelope 직렬화 비용**: 12KB JSON 을 매번 `JSON.parse` → `JSON.stringify` 하는 건 cheap 하지만, raw 가 잘못된 JSON 시작 (`{` 로 시작하지만 truncated) 이면 `JSON.parse` throw. `try/catch` 로 감싸 `null` 반환 — heuristic 으로 자연스럽게 떨어짐.
- **`AgentSpec` 타입 위치**: 코드베이스에서 `AgentSpec` 정의가 `team.ts` 외 다른 곳일 수 있으니 구현자는 `grep -rn "interface AgentSpec\|type AgentSpec ="` 로 확정 후 `result_cap` 필드 추가.
- **부모 LLM 의 요약 신뢰도**: heuristic head/tail 만 보고 부모가 잘못된 결론을 내릴 수 있음 — 이 위험은 `artifact_paths` 별도 export + Lead 가 필요시 `read_file` skill 로 raw artifact 직접 읽도록 유도해서 완화. 이는 S4 (work ledger) 와 자연스럽게 맞물림.
- **테스트의 `providers.stream` mocking**: ESM dynamic import 라 vitest 에서 `vi.mock('./providers', ...)` 패턴 필요. 기존 `session.test.ts` 의 mocking 스타일 따라갈 것.

---

## 의존성

- **선행**: 없음. 단독 P0 작업.
- **후속**: S2 (microcompact) 가 `delegation_closed.data.truncated` 신호를 보고 history 압축 우선순위 결정 가능. S4 (work ledger) 가 `artifact_paths` 를 ledger entry 로 흡수.
