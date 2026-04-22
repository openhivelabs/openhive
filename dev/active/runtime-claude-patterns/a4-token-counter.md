# A4 — Token Counter + Effective Window Math

> **ADDENDUM (lock-in, 2026-04-22) — plan.md §2, §4 우선.**
> 1. **Phase 3 (`shouldBlockTurn` throw) 는 env-gated (`OPENHIVE_BLOCK_ON_OVERFLOW=1`)**, 본 라운드 default `0` (로깅만). 기존 흐름 깨지 않음.
> 2. **Phase 4 (circuit breaker) 는 helper 만 export, 호출처 추가 안 함.** Auto-compact 본 구현 PR 에서 와이어링.
> 3. **S2 의 트리거에 `shouldMicrocompact` AND 조건은 v2.** 본 라운드 S2 는 시간축 only.
> 4. **모델 카탈로그 (`CONTEXT_WINDOW`) 검증**: claude-opus-4-7 200K, claude-opus-4-7[1m] 1M, gpt-5 계열 400K (codex), Copilot 측은 보수적 200K. 모델 rev 시 재검증 — TODO comment 박을 것.
> 5. **Phase A 와 병렬 가능 (plan §3).** S4 와 동시 머지 OK (다른 파일).

---


**Goal:** char 기반 추정(`systemChars/toolsChars/historyChars`)을 실제 token 단위 추정으로 대체하고, provider × model 별 effective context window 계산을 단일 모듈에 모은다. S2 microcompact / 추후 auto-compact / UI 경고가 모두 같은 함수 (`shouldMicrocompact`, `shouldBlockTurn`) 를 호출하게 만들어 임계값 일관성을 확보.

**Why now:** `apps/web/lib/server/engine/session.ts:632-642` 의 `systemChars/toolsChars/historyChars` 는 "총 분량 감각" 만 주는 proxy 라 압축 결정을 못 내린다. 30분 리포팅 세션이 200K window 의 70% 를 넘었는지 80% 를 넘었는지 모른 채 S2 의 `STALE_AFTER_MS` 시간축 하나로만 판단하면, 모델별 window 차이 (Opus 200K vs Opus[1m] 1M vs Haiku 200K) 와 max_output 예약량을 무시하게 된다. Claude Code 의 `effectiveWindow` 공식은 BQ 데이터로 검증된 값이고, 같은 산수를 OpenHive 도 그대로 쓰면 된다.

**Reference:** `codeaashu/claude-code/utils/tokens.ts`, `services/compact/autoCompact.ts`. 핵심 차용 항목:
- `tokenCountWithEstimation` — API 가 마지막에 보고한 `usage.input_tokens` 를 권위(authoritative) 로 삼고, 그 이후 추가된 메시지만 자체 추정으로 보강.
- `roughTokenCountEstimation` — 4 chars/token, 보수적 1.33x pad, 이미지 flat 2000.
- `effectiveWindow = contextWindow - min(maxOutput, 20_000)`, autocompact 13K 버퍼, manual 3K 버퍼.
- 3 회 연속 autocompact 실패 → 세션 단위 disable (circuit breaker).

**Out of scope (이 스펙 안 함):**
- 정밀 BPE 토크나이저 도입 (`tiktoken`/`@anthropic-ai/tokenizer` 등 새 의존성). 향후 drift 데이터 보고 결정.
- Auto-compact 본 구현. 본 스펙은 "압축 트리거를 결정하는 산수" 와 "circuit breaker 자리만" 만든다 — 실제 압축 로직은 후속.
- Provider 가 보고하지 않는 cache token 의 토큰 추정.
- UI 경고 토스트. (값만 노출, UI 는 별도 작업.)

---

## 0. 사전 정리: 현재 상태와 닿는 지점

### 0.1 char 기반 추정 (대체 대상)

`apps/web/lib/server/engine/session.ts:632-642`:

```
632  // Phase G1: attribute payload size to system vs tools vs history so we can
633  // later rank which region is driving spend. Char counts, not tokens — a
634  // cheap proxy that doesn't need a tokenizer.
635  const systemChars = systemPrompt.length
636  const toolsChars = openaiTools ? JSON.stringify(openaiTools).length : 0
637  let historyChars = 0
638  for (const m of history) {
639    if (typeof m.content === 'string') historyChars += m.content.length
640    else if (Array.isArray(m.content)) historyChars += JSON.stringify(m.content).length
641    if (Array.isArray(m.tool_calls)) historyChars += JSON.stringify(m.tool_calls).length
642  }
```

`recordUsage` 호출 (`session.ts:670-685`) 가 이 세 값을 그대로 `systemChars/toolsChars/historyChars` 로 `~/.openhive/sessions/{id}/usage.json` 에 떨궈 둔다. **삭제하지 않는다 — 본 스펙은 옆에 token 필드를 추가하는 방향.** 회귀를 막고, 둘을 한동안 병기해 drift 검증 데이터로 쓴다.

### 0.2 provider 가 이미 보고하는 input_tokens

세 provider 모두 `kind: 'usage'` delta 를 통해 `input_tokens` 를 정확히 보고한다 — 이건 추정이 아니라 권위 값이다.

- **Claude** (`apps/web/lib/server/engine/providers.ts:118-186`): `message_start.message.usage.input_tokens` + `message_delta.usage.output_tokens`. `cache_read_input_tokens`, `cache_creation_input_tokens` 도 같이 옴.
- **Copilot** (`providers.ts:62-76`): `usage.prompt_tokens` + `usage.prompt_tokens_details.cached_tokens`.
- **Codex** (`providers.ts:233-244`): `response.usage.input_tokens` + `input_tokens_details.cached_tokens`.

즉 **다음 turn 진입 시점에는 직전 turn 의 실제 input token 이 손에 있다.** 본 스펙의 추정기는 (a) 다음 turn 의 history 가 아직 LLM 에 안 가서 보고가 없는 상황, (b) 추가된 사용자/도구 메시지 토큰 가산, (c) drift 캘리브레이션 두 용도로 쓰인다.

### 0.3 모델 카탈로그 위치

`apps/web/lib/server/providers/models.ts:18-29` — `CLAUDE_CODE_MODELS`, `CODEX_MODELS`, `COPILOT_FALLBACK`. context window 정보는 없음. **본 스펙의 `contextWindow.ts` 와 `models.ts` 는 분리 유지** — `models.ts` 는 UI 표시용 카탈로그, `contextWindow.ts` 는 런타임 산수용. 두 곳에 같은 ID 가 등장하지만 책임이 다르다.

---

## Phase 1 — Core: contextWindow + estimator 모듈

### Task 1.1 — `contextWindow.ts` 신설

**Files:**
- Create: `apps/web/lib/server/usage/contextWindow.ts`

- [ ] Step 1: 디렉터리 신설 (`apps/web/lib/server/usage/`). 기존 `apps/web/lib/server/usage.ts` 는 그대로 두고, 본 모듈은 `usage/` 디렉터리 안. 추후 `usage.ts` 도 `usage/index.ts` 로 흡수 가능하지만 본 스펙 범위 밖.

- [ ] Step 2: 모듈 헤더 docstring — "Per-(provider, model) context window + max-output table. Single source of truth for engine sizing decisions. Numbers reflect publicly documented ceilings as of 2026-04; verify on model rev." 명시.

- [ ] Step 3: 테이블 정의.

```ts
export interface ModelWindow {
  /** 입력 토큰 한도 (system + tools + history + 사용자 turn). */
  input: number
  /** 모델이 출력할 수 있는 최대 토큰. effectiveWindow 계산 시 reserve. */
  output: number
}

export const CONTEXT_WINDOW: Record<string, Record<string, ModelWindow>> = {
  // Anthropic — Claude Code OAuth path. 1m beta 는 별도 model id.
  'claude-code': {
    'claude-opus-4-7':       { input:   200_000, output: 32_000 },
    'claude-opus-4-7[1m]':   { input: 1_000_000, output: 32_000 },
    'claude-sonnet-4-6':     { input:   200_000, output: 64_000 },
    'claude-sonnet-4-6[1m]': { input: 1_000_000, output: 64_000 },
    'claude-haiku-4-5':      { input:   200_000, output: 16_000 },
  },
  // OpenAI Codex — ChatGPT backend Responses API.
  // GPT-5 계열 공개 ceiling 기준. 모델 rev 시 재검증.
  codex: {
    'gpt-5':        { input: 400_000, output: 128_000 },
    'gpt-5-mini':   { input: 400_000, output: 128_000 },
    'gpt-5.4':      { input: 400_000, output: 128_000 },
    'gpt-5.4-mini': { input: 400_000, output: 128_000 },
    // TODO(a4): o3 / o3-mini 가 codex 카탈로그에 들어오면 추가.
  },
  // GitHub Copilot — Copilot 이 노출하는 동일 모델 ID. Copilot 측은
  // /models 응답에 window 를 안 주므로 보수적 OpenAI 기본값을 그대로 채택.
  copilot: {
    'gpt-5':        { input: 200_000, output: 32_000 },
    'gpt-5-mini':   { input: 200_000, output: 32_000 },
    'gpt-5.4':      { input: 200_000, output: 32_000 },
    'gpt-5.4-mini': { input: 200_000, output: 32_000 },
    'gpt-4o':       { input: 128_000, output: 16_000 },
    'gpt-4o-mini':  { input: 128_000, output: 16_000 },
    'o3':           { input: 200_000, output: 100_000 },
    'o3-mini':      { input: 200_000, output: 100_000 },
  },
}

const SAFE_DEFAULT: ModelWindow = { input: 128_000, output: 8_000 }

export function contextWindow(providerId: string, model: string): ModelWindow {
  const entry = CONTEXT_WINDOW[providerId]?.[model]
  if (entry) return entry
  // 알려지지 않은 모델은 안전 기본값. crash 금지.
  return SAFE_DEFAULT
}
```

- [ ] Step 4: `effectiveWindow` 함수 — Claude Code 의 산수를 그대로 옮긴다.

```ts
const AUTOCOMPACT_BUFFER_DEFAULT = 13_000
const BLOCKING_BUFFER_DEFAULT    =  3_000
const WARNING_BUFFER_DEFAULT     = 20_000
const MAX_OUTPUT_RESERVE         = 20_000

export interface EffectiveWindow {
  /** input - reserveOutput. 실제 prompt 가 들어갈 수 있는 상한. */
  window: number
  /** 이 값을 넘으면 autocompact 시도 (microcompact 단계). */
  autoCompactThreshold: number
  /** 사용자/UI 경고 임계 (block 은 아님). */
  warningThreshold: number
  /** 이 값을 넘으면 새 turn 자체를 막아야 함. */
  blockingLimit: number
  /** 디버깅용 — 어떤 버퍼/모델이 적용됐는지. */
  meta: {
    providerId: string
    model: string
    rawInput: number
    rawOutput: number
    reserveOutput: number
    autoCompactBuffer: number
    blockingBuffer: number
  }
}

export function effectiveWindow(providerId: string, model: string): EffectiveWindow {
  const cw = contextWindow(providerId, model)
  const autoBuf  = numEnv('OPENHIVE_AUTOCOMPACT_BUFFER', AUTOCOMPACT_BUFFER_DEFAULT)
  const blockBuf = numEnv('OPENHIVE_BLOCKING_BUFFER',    BLOCKING_BUFFER_DEFAULT)
  const warnBuf  = numEnv('OPENHIVE_WARNING_BUFFER',     WARNING_BUFFER_DEFAULT)
  const reserveOutput = Math.min(cw.output, MAX_OUTPUT_RESERVE)
  const window = cw.input - reserveOutput
  return {
    window,
    autoCompactThreshold: window - autoBuf,
    warningThreshold:     window - warnBuf,
    blockingLimit:        window - blockBuf,
    meta: {
      providerId, model,
      rawInput: cw.input,
      rawOutput: cw.output,
      reserveOutput,
      autoCompactBuffer: autoBuf,
      blockingBuffer:    blockBuf,
    },
  }
}

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
```

- [ ] Step 5: 검산 케이스 (주석으로 남겨, 테스트와 1:1).

```
// effectiveWindow('claude-code','claude-opus-4-7[1m]')
//   rawInput 1_000_000, rawOutput 32_000, reserveOutput 20_000
//   window = 980_000
//   autoCompactThreshold = 967_000
//   warningThreshold     = 960_000
//   blockingLimit        = 977_000
// effectiveWindow('claude-code','claude-haiku-4-5')
//   reserveOutput 16_000 (output<20K), window = 184_000
//   autoCompactThreshold = 171_000
```

### Task 1.2 — `tokens.ts` 추정기

**Files:**
- Create: `apps/web/lib/server/usage/tokens.ts`

- [ ] Step 1: 모듈 헤더 — "Pure-JS token estimator. Not a real BPE tokenizer; intentionally conservative (×4/3 pad) so we err on triggering compaction early rather than late." 명시.

- [ ] Step 2: 상수와 환경변수.

```ts
const CHARS_PER_TOKEN = 4
const PAD_FACTOR_DEFAULT = 4 / 3       // ≈ 1.333
const IMAGE_TOKENS_FLAT  = 2_000
const ROLE_OVERHEAD      = 4           // role + 구조 메타 per message

function padFactor(): number {
  const raw = process.env.OPENHIVE_TOKEN_PAD_FACTOR
  if (!raw) return PAD_FACTOR_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : PAD_FACTOR_DEFAULT
}
```

- [ ] Step 3: 텍스트 추정기 — 4 chars/token 에 pad.

```ts
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.ceil((text.length / CHARS_PER_TOKEN) * padFactor())
}
```

- [ ] Step 4: 메시지 단위 walker. ChatMessage 는 `apps/web/lib/server/providers/types.ts` 의 OpenAI-shape 를 따르므로, content 가 string 이거나 block 배열. tool_calls 는 별도. tool 결과 메시지 (`role: 'tool'`) 는 string content.

```ts
import type { ChatMessage } from '../providers/types'

export function estimateMessageTokens(msg: ChatMessage): number {
  let total = ROLE_OVERHEAD
  // content
  if (typeof msg.content === 'string' && msg.content) {
    total += estimateTextTokens(msg.content)
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      const b = block as Record<string, unknown>
      const type = b.type
      if (type === 'image' || type === 'image_url') {
        total += IMAGE_TOKENS_FLAT
      } else if (type === 'text' && typeof b.text === 'string') {
        total += estimateTextTokens(b.text)
      } else if (type === 'tool_use') {
        // Anthropic-shape tool_use 가 history 에 직접 들어오는 경우 (드묾).
        const input = (b.input ?? {}) as unknown
        total += estimateTextTokens(JSON.stringify(input))
      } else if (type === 'tool_result') {
        const c = b.content
        total += estimateTextTokens(typeof c === 'string' ? c : JSON.stringify(c ?? ''))
      } else {
        // 알 수 없는 block — 보수적으로 JSON 길이로 계산.
        total += estimateTextTokens(JSON.stringify(b))
      }
    }
  }
  // OpenAI-shape tool_calls
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const fn = tc.function ?? { name: '', arguments: '' }
      total += estimateTextTokens(fn.name ?? '')
      total += estimateTextTokens(fn.arguments ?? '')
      total += 8 // call_id + 구조 overhead
    }
  }
  return total
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  let sum = 0
  for (const m of msgs) sum += estimateMessageTokens(m)
  return sum
}
```

- [ ] Step 5: tools schema 추정 — `streamTurn` 이 `JSON.stringify(openaiTools)` 한 결과 길이에서 토큰 환산.

```ts
import type { ToolSpec } from '../providers/types'

export function estimateToolsTokens(tools: ToolSpec[] | undefined | null): number {
  if (!tools || tools.length === 0) return 0
  return estimateTextTokens(JSON.stringify(tools)) + tools.length * 4
}
```

- [ ] Step 6: 권위(API) + 추정 결합. Claude Code 의 `tokenCountWithEstimation` 패턴.

```ts
export interface CountWithApiOpts {
  /** 권위 값. 직전 turn 에서 provider 가 보고한 input_tokens. */
  apiReportedInputTokens?: number | null
  /**
   * 권위 값이 커버하는 마지막 메시지 인덱스 (포함). 이 인덱스 이후의
   * 메시지는 추정으로 가산. null 이면 messages 전체를 추정으로.
   */
  apiReportedAtIndex?: number | null
  /** system prompt 토큰 (옵션). 권위 값에 이미 포함되면 0 으로 둘 것. */
  systemTokens?: number
  /** tools schema 토큰 (옵션). 권위 값에 이미 포함되면 0 으로 둘 것. */
  toolsTokens?: number
}

export function tokenCountWithEstimation(
  messages: ChatMessage[],
  opts: CountWithApiOpts = {},
): number {
  const sys   = opts.systemTokens ?? 0
  const tools = opts.toolsTokens ?? 0
  const api   = opts.apiReportedInputTokens ?? null
  const idx   = opts.apiReportedAtIndex ?? null

  if (api !== null && idx !== null && idx >= 0) {
    // 권위 + 그 이후 추가분만 추정.
    let added = 0
    for (let i = idx + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (msg) added += estimateMessageTokens(msg)
    }
    return api + added
  }
  // API 보고 없음 — 전체 추정 + system + tools.
  return sys + tools + estimateMessagesTokens(messages)
}
```

### Task 1.3 — 압축/차단 트리거 public API

**Files:**
- Modify: `apps/web/lib/server/usage/tokens.ts` (같은 파일에 export)

- [ ] Step 1: S2 microcompact 와 후속 auto-compact 가 동일 함수를 호출하도록 설계.

```ts
import { effectiveWindow } from './contextWindow'

export function shouldMicrocompact(
  estimatedTokens: number,
  providerId: string,
  model: string,
): boolean {
  return estimatedTokens > effectiveWindow(providerId, model).warningThreshold
}

export function shouldAutoCompact(
  estimatedTokens: number,
  providerId: string,
  model: string,
): boolean {
  return estimatedTokens > effectiveWindow(providerId, model).autoCompactThreshold
}

export function shouldBlockTurn(
  estimatedTokens: number,
  providerId: string,
  model: string,
): boolean {
  return estimatedTokens > effectiveWindow(providerId, model).blockingLimit
}
```

- [ ] Step 2: S2 (`microcompact.ts`) 가 이 함수를 호출. 본 스펙은 그 호출 지점만 합의 — 실제 통합은 S2 스펙에서 진행. S2 가 "시간축 통과 + `shouldMicrocompact` true" 두 조건을 AND 로 만족할 때만 압축하도록 한다.

---

## Phase 2 — `recordUsage` 통합 + drift 이벤트

### Task 2.1 — `streamTurn` 에서 추정값 계산

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (632-686 구간)

- [ ] Step 1: 기존 char 카운팅 직후, token 추정도 같이 계산. char 필드는 **유지** (drift 검증 + 기존 usage 뷰 호환).

```ts
import {
  estimateMessagesTokens,
  estimateTextTokens,
  estimateToolsTokens,
} from '../usage/tokens'
import { effectiveWindow as computeEffectiveWindow } from '../usage/contextWindow'

// ... 기존 systemChars/toolsChars/historyChars 계산 직후 ...
const systemTokens  = estimateTextTokens(systemPrompt)
const toolsTokens   = estimateToolsTokens(openaiTools)
const historyTokens = estimateMessagesTokens(history)
const estimatedInputTokens = systemTokens + toolsTokens + historyTokens
const ew = computeEffectiveWindow(node.provider_id, node.model)
```

- [ ] Step 2: `usage` delta 처리 분기 (`session.ts:666-688`) 에서 `recordUsage` 호출 시 새 필드 전달.

### Task 2.2 — `recordUsage` 시그니처 확장

**Files:**
- Modify: `apps/web/lib/server/usage.ts`

- [ ] Step 1: `RecordUsageInput` 에 옵션 필드 추가 (전부 optional — 기존 호출자 깨지지 않게).

```ts
export interface RecordUsageInput {
  // ...기존 필드 유지...
  /** 우리가 사전에 추정한 input 토큰 (system + tools + history). */
  estimatedInputTokens?: number
  /** provider 가 사후에 보고한 실제 input 토큰. inputTokens 와 동일하지만
   *  drift 분석 시 명시적으로 분리 보관. */
  actualInputTokens?: number
  /** 이 호출 시점의 effective window 메타. */
  effectiveWindow?: number
  autoCompactThreshold?: number
  warningThreshold?: number
  blockingLimit?: number
  /** 어떤 임계가 trigger 됐는지 (없으면 'none'). */
  thresholdTriggered?: 'none' | 'warning' | 'autocompact' | 'blocking'
}
```

- [ ] Step 2: `UsageRow` 에 동일 키 추가 (snake_case). 누락 시 `0` / `'none'` 으로 직렬화.

```ts
interface UsageRow {
  // ...기존...
  estimated_input_tokens: number
  actual_input_tokens: number
  effective_window: number
  autocompact_threshold: number
  warning_threshold: number
  blocking_limit: number
  threshold_triggered: 'none' | 'warning' | 'autocompact' | 'blocking'
}
```

- [ ] Step 3: 기존 `usage.json` 파일은 새 필드 없는 row 가 섞여 있을 수 있다. `readRows` 에서 default 채워 normalize — 기존 row 전체 마이그레이션은 **하지 않음** (정보가 없어서 의미 없음).

### Task 2.3 — drift 이벤트

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (usage delta 분기)
- Reference: 이벤트 타입은 기존 `makeEvent` 헬퍼 사용

- [ ] Step 1: usage delta 수신 직후, `actual = delta.input_tokens ?? 0`, `estimated = estimatedInputTokens` (Task 2.1 에서 계산한 값) 비교.

```ts
const actual = delta.input_tokens ?? 0
if (actual > 0 && estimatedInputTokens > 0) {
  const driftRatio = Math.abs(actual - estimatedInputTokens) / actual
  if (driftRatio > 0.25) {
    yield makeEvent('token.estimate.drift', sessionId, {
      provider_id: node.provider_id,
      model: node.model,
      estimated: estimatedInputTokens,
      actual,
      drift_ratio: Number(driftRatio.toFixed(3)),
      pad_factor: Number(process.env.OPENHIVE_TOKEN_PAD_FACTOR ?? (4/3).toFixed(4)),
    }, { depth, node_id: node.id })
  }
}
```

- [ ] Step 2: 이벤트 이름 컨벤션 — 기존 이벤트는 dot-namespace (`tool.start`, `delegation.end` 등) 패턴. `token.estimate.drift` 도 동일 컨벤션. 새 이벤트 타입을 events 카탈로그 (`apps/web/lib/server/events.ts` 또는 type union) 에 추가.

- [ ] Step 3: drift 이벤트는 events.jsonl 에 들어가지만 transcript 에는 안 보낸다 (사용자 노출 X). 이미 `makeEvent` 가 routing 분기를 가지고 있으면 그 룰을 따른다.

### Task 2.4 — threshold 메타 기록

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts`

- [ ] Step 1: `recordUsage` 호출 시 `thresholdTriggered` 결정.

```ts
let thresholdTriggered: 'none' | 'warning' | 'autocompact' | 'blocking' = 'none'
if      (estimatedInputTokens > ew.blockingLimit)        thresholdTriggered = 'blocking'
else if (estimatedInputTokens > ew.autoCompactThreshold) thresholdTriggered = 'autocompact'
else if (estimatedInputTokens > ew.warningThreshold)     thresholdTriggered = 'warning'

recordUsage({
  // ...기존 필드...
  estimatedInputTokens,
  actualInputTokens: actual,
  effectiveWindow: ew.window,
  autoCompactThreshold: ew.autoCompactThreshold,
  warningThreshold: ew.warningThreshold,
  blockingLimit: ew.blockingLimit,
  thresholdTriggered,
})
```

---

## Phase 3 — Microcompact 트리거 wiring

### Task 3.1 — S2 가 Phase 1 API 사용

**Files:**
- Modify: `apps/web/lib/server/engine/microcompact.ts` (S2 가 만든 후)

- [ ] Step 1: S2 의 "압축 여부 판단" 분기에서 `shouldMicrocompact(estimatedTokens, providerId, model)` 를 시간축 조건과 AND. 시간만 넘었지만 토큰은 여유 → skip. 토큰만 넘었지만 캐시 hot → 본 스펙 범위 밖 (S2 가 결정).

- [ ] Step 2: 본 스펙은 함수 export 만 보장. S2 의 호출 케이스는 S2 스펙에 명시.

### Task 3.2 — `shouldBlockTurn` 사용처

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (`streamTurn` 진입부)

- [ ] Step 1: streamTurn 진입 직후, `shouldBlockTurn(estimatedInputTokens, ...)` true 면 turn 시작 전 차단.

```ts
if (shouldBlockTurn(estimatedInputTokens, node.provider_id, node.model)) {
  yield makeEvent('turn.blocked', sessionId, {
    reason: 'context_overflow',
    estimated_tokens: estimatedInputTokens,
    blocking_limit: ew.blockingLimit,
    provider_id: node.provider_id,
    model: node.model,
  }, { depth, node_id: node.id })
  throw new ContextOverflowError(
    `Context (${estimatedInputTokens}t) exceeds blocking limit (${ew.blockingLimit}t) for ${node.provider_id}/${node.model}.`
  )
}
```

- [ ] Step 2: `ContextOverflowError` 는 `engine/errors.ts` 에 추가 (기존 에러 카탈로그와 동일한 패턴). `runDelegation` 의 catch 가 이를 식별해 sub-agent 라면 부모에게 요약 결과만 전달, Lead 라면 세션을 `interrupted` 로 마킹.

- [ ] Step 3: 본 차단은 Phase 3 까지는 **로깅만** 하고 throw 는 Phase 4 와 묶어서 활성화 — 기존 흐름 깨지 않도록 env flag (`OPENHIVE_BLOCK_ON_OVERFLOW=1`) 뒤에 둔다.

---

## Phase 4 — Circuit breaker (auto-compact 대비 발판)

본 스펙은 auto-compact 본 구현을 하지 않는다. 단, 향후 auto-compact 이 들어왔을 때 무한 루프 / 반복 실패를 막을 자리만 만든다.

### Task 4.1 — 세션 단위 카운터

**Files:**
- Modify: `apps/web/lib/server/engine/session-registry.ts` (또는 RunState 가 있는 곳)

- [ ] Step 1: RunState 에 두 필드 추가.

```ts
interface RunState {
  // ...기존...
  autoCompactConsecutiveFailures: number
  autoCompactDisabledForSession: boolean
}
```

- [ ] Step 2: 초기값 `0`, `false`. 세션 종료 시 자연 소멸 (FS 영속화 안 함 — 다음 세션은 새 카운터).

### Task 4.2 — Public helper

**Files:**
- Create: `apps/web/lib/server/usage/circuitBreaker.ts`

- [ ] Step 1: 세션 ID → RunState 룩업으로 카운터 조작.

```ts
import { state } from '../engine/session-registry' // 가상 — 실제 위치 확인

const FAIL_LIMIT = 3

export function recordAutoCompactFailure(sessionId: string, reason: string): {
  disabled: boolean
  failures: number
} {
  const rs = state().runs.get(sessionId)
  if (!rs) return { disabled: false, failures: 0 }
  rs.autoCompactConsecutiveFailures += 1
  if (rs.autoCompactConsecutiveFailures >= FAIL_LIMIT) {
    rs.autoCompactDisabledForSession = true
  }
  return {
    disabled: rs.autoCompactDisabledForSession,
    failures: rs.autoCompactConsecutiveFailures,
  }
}

export function recordAutoCompactSuccess(sessionId: string): void {
  const rs = state().runs.get(sessionId)
  if (rs) rs.autoCompactConsecutiveFailures = 0
}

export function isAutoCompactDisabled(sessionId: string): boolean {
  const rs = state().runs.get(sessionId)
  return rs?.autoCompactDisabledForSession ?? false
}
```

- [ ] Step 2: 3회 누적 → `autocompact.disabled` 이벤트 emit. 향후 auto-compact 가 진입 직전 `isAutoCompactDisabled` 체크.

```ts
// (auto-compact 본 구현 시점에) 호출:
const r = recordAutoCompactFailure(sessionId, err.message)
if (r.disabled) {
  yield makeEvent('autocompact.disabled', sessionId, {
    reason: 'consecutive_failures',
    failures: r.failures,
    last_error: err.message,
  })
}
```

- [ ] Step 3: 본 스펙에서는 helper 모듈만 만들고, 실제 `recordAutoCompactFailure` 호출은 후속 auto-compact 스펙에서 진행. 본 스펙에서는 import 를 거는 코드는 추가하지 않는다 — dead code 회피. 이름만 export.

---

## Phase 5 — 환경 변수 / 설정

| Env | Default | 의미 |
|---|---|---|
| `OPENHIVE_TOKEN_PAD_FACTOR` | `1.333` (4/3) | char→token 환산 후 곱하는 보수 pad. drift 데이터로 튜닝. |
| `OPENHIVE_AUTOCOMPACT_BUFFER` | `13_000` | effectiveWindow 에서 빼서 autocompact 임계 산출. |
| `OPENHIVE_BLOCKING_BUFFER` | `3_000` | turn 차단 임계. |
| `OPENHIVE_WARNING_BUFFER` | `20_000` | UI 경고 임계. |
| `OPENHIVE_BLOCK_ON_OVERFLOW` | `0` (disabled) | `shouldBlockTurn` true 시 throw 활성화. Phase 3 까지는 로깅만. |

전부 lazy 읽기 — 함수 호출 시점에 `process.env` 조회 (테스트가 setEnv 로 갈아끼울 수 있게).

---

## Phase 6 — 테스트

**Files:**
- Create: `apps/web/lib/server/usage/contextWindow.test.ts`
- Create: `apps/web/lib/server/usage/tokens.test.ts`

### contextWindow.test.ts

- [ ] `effectiveWindow('claude-code', 'claude-opus-4-7[1m]')` →
  - window === 980_000
  - autoCompactThreshold === 967_000
  - warningThreshold === 960_000
  - blockingLimit === 977_000
- [ ] `effectiveWindow('claude-code', 'claude-opus-4-7')` →
  - window === 180_000 (200K - 20K reserve)
  - autoCompactThreshold === 167_000
- [ ] `effectiveWindow('claude-code', 'claude-haiku-4-5')` →
  - reserveOutput === 16_000 (output<20K → cap 안 발동)
  - window === 184_000
- [ ] `effectiveWindow('copilot', 'unknown-model')` → SAFE_DEFAULT 적용, crash 없음, window === 120_000.
- [ ] env override: `OPENHIVE_AUTOCOMPACT_BUFFER=5000` 셋팅 후 같은 호출 → autoCompactThreshold 가 그만큼 위로 이동.

### tokens.test.ts

- [ ] `estimateTextTokens('')` === 0.
- [ ] `estimateTextTokens('a'.repeat(400))` ≈ 400/4 * 4/3 = 134 (`Math.ceil` 기준 134).
- [ ] `estimateMessageTokens({ role:'user', content:'hello world' })` > 0 그리고 ROLE_OVERHEAD(4) 포함 확인.
- [ ] image block 포함 시 IMAGE_TOKENS_FLAT(2000) 가산.
- [ ] tool_calls 가 있는 assistant 메시지 → name + arguments + 8 가산.
- [ ] `tokenCountWithEstimation(messages, { apiReportedInputTokens: 50_000, apiReportedAtIndex: messages.length - 2 })` → API 값 + 마지막 1개 메시지 추정만.
- [ ] `shouldMicrocompact(961_000, 'claude-code', 'claude-opus-4-7[1m]')` === true (warning 960K 초과).
- [ ] `shouldBlockTurn(978_000, 'claude-code', 'claude-opus-4-7[1m]')` === true (blocking 977K 초과).
- [ ] `shouldBlockTurn(960_000, ...)` === false.

### drift 시뮬레이션

- [ ] 합성 케이스: 추정 100K, actual 200K → driftRatio 0.5 → drift 이벤트 1회 발생.
- [ ] 추정 100K, actual 110K → driftRatio 0.1 → drift 이벤트 없음.
- [ ] 본 테스트는 session 통합 테스트 (`session.test.ts`) 에 추가하거나 events 캡처 헬퍼로 단위 검증.

### Estimator vs API 실측 (manual / smoke)

- [ ] `pnpm --filter @openhive/web test` 의 일부로 들어가지 않는 별도 smoke. Claude Opus 에 1000-token 정도 메시지 보내고 `usage.input_tokens` 와 `estimateMessagesTokens(...)` 비교, `|actual - estimated| / actual < 0.25` 충족 확인.
- [ ] 결과는 `dev/active/runtime-claude-patterns/a4-drift-baseline.md` 에 한 번 기록 (본 스펙 완료 시 별도 메모로 추가).

---

## Cross-cutting / CLAUDE.md 준수

- **새 의존성 없음.** Pure JS (`Math.ceil`, `JSON.stringify`) 만 사용. `tiktoken`/wasm 토크나이저 도입은 drift 데이터 본 후 별도 결정.
- **FS-only state.** circuit breaker 는 RunState 안 (in-memory). 세션 종료 시 자연 소멸. usage.json 은 기존 append 패턴 유지.
- **globalThis 보호.** RunState 자체가 이미 `Symbol.for('openhive.engine.runs')` 같은 키로 보호되고 있으면 그 패턴 그대로. 본 스펙이 새 globalThis 항목을 추가하지는 않는다.
- **Per-node provider+model 보존.** `effectiveWindow` 가 `(providerId, model)` 를 받으므로 노드별 다른 모델이 섞여도 각자 임계로 평가. 공유 ChatModel 추상화 만들지 않음.
- **i18n.** 본 스펙은 사용자 노출 문자열 추가 없음 (drift / blocked 이벤트는 내부 관측용). UI 노출 시점에 `t()` 통과 — 별도 작업.
- **Long-lived 객체 lazy 생성.** `effectiveWindow` 는 호출당 객체 생성, 가벼우니 캐시 안 함. `contextWindow` 테이블은 module-level const — 부팅 비용 0.

---

## 의존성 / 통합 영향

**선행:** 없음. (P0 의 어느 스펙과도 직교.)

**후행 (이 스펙이 풀어주는 것):**
- S2 microcompact: `shouldMicrocompact` 를 시간축과 AND 조건으로 사용 가능.
- 미래 auto-compact 스펙: `shouldAutoCompact`, circuit breaker helper 가 그대로 입력.
- UI 컨텍스트 사용량 게이지 / 경고: `effective_window`, `estimated_input_tokens` 가 usage.json 에 들어와 있으니 별도 백엔드 작업 없이 프론트에서 끌어 쓸 수 있음.

**파일 충돌 위험:**
- `session.ts:632-686` 는 S1 / S2 / A1 이 모두 건드린다. 본 스펙은 그 구간에 토큰 계산 ~10 줄 추가 + `recordUsage` 호출 인자 확장만. S1/S2 와 직렬 진행 권장.
- `usage.ts` 의 `RecordUsageInput` 확장은 호환 유지 (전부 optional) — 다른 호출자 깨지지 않음.

---

## 마무리 체크리스트

- [ ] `apps/web/lib/server/usage/contextWindow.ts` 신설, 표 검증.
- [ ] `apps/web/lib/server/usage/tokens.ts` 신설, estimator + threshold helpers.
- [ ] `apps/web/lib/server/usage/circuitBreaker.ts` 신설 (호출처는 후속).
- [ ] `session.ts:632-686` 구간에 token 추정 + threshold meta 추가, char 필드는 유지.
- [ ] `usage.ts` `RecordUsageInput` / `UsageRow` 확장.
- [ ] drift 이벤트 emit (>25%).
- [ ] env flag 5개 문서화.
- [ ] 단위 테스트 통과.
- [ ] manual drift smoke 1회 측정 후 baseline 메모 추가.
- [ ] CLAUDE.md 변경 없음 (본 스펙은 아키텍처 변경 아님).
- [ ] 다이어그램 업데이트 불필요 (저장 레이아웃/엔진 플로우 변경 없음).
