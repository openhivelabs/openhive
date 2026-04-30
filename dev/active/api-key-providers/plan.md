# API-Key Providers 통합 플랜 v2

**목표**: PROVIDERS 목록의 API-key 4종(Anthropic / OpenAI / Google Gemini / Vertex AI)을 엔진에 연결. 현재 OAuth 3종(claude-code / codex / copilot)과 가능한 한 동등한 동작.

**Lead**: 본 문서.
**작성일**: 2026-04-30 (v4 — Phase A~E 구현 완료, 폴리시까지 마무리).

---

## 🟢 IMPLEMENTATION STATUS (2026-04-30 final)

| Phase | 상태 | 산출 |
|---|:---:|---|
| 0 — Probes | ✅ 완료 → 키 폐기 | wire / 캐싱 / Thought Signatures wire 위치 / Vertex global 검증 |
| A — Anthropic api_key | ✅ 머지됨 | claude.ts api_key 분기 + retry/errors/cheap-model 인프라 + i18n + 65 tests |
| B — Codex 정규화기 추출 | ✅ 머지됨 | openai-response-shared.ts (~250 LOC), streamCodex 19줄 wrapper |
| C — OpenAI api_key | ✅ 머지됨 | openai.ts + OpenAIResponsesCachingStrategy + previous_response_id chain |
| D — Gemini api_key | ✅ 머지됨 | gemini-shared.ts + gemini.ts + thoughtSignature round-trip + googleSearch 합성 |
| E — Vertex AI | ✅ 머지됨 | auth/vertex.ts (JWT zero-install) + vertex.ts + semaphore default-on |
| 폴리시 1 — disconnect cache invalidation | ✅ | cache-control.ts 통합 hook |
| 폴리시 2 — redactCredentials wiring | ✅ | 6 어댑터 throw 경로 모두 적용 |
| 폴리시 3 — Anthropic ttl='1h' 옵션 | ✅ | env + per-call 둘 다 |
| 폴리시 4 — OpenAI effort=minimal 게이트 | ✅ | supportsNativeSearch 헬퍼 |
| 폴리시 5 — Native vs skill 카운터 분리 | ✅ | webSearchSkill / webSearchNative |
| 폴리시 6 — env 게이팅 (OPENHIVE_PROVIDER_*) | ✅ | UI 리스트 필터 |
| 폴리시 7 — per-agent native_search 토글 | ✅ | NodeEditor 체크박스 + AgentSpec |
| 폴리시 8 — engine error 분류 확장 | ✅ | classify() 6 형식 인식 |
| 폴리시 9 — 문서 4편 + CHANGELOG | ✅ | docs/providers/{anthropic,openai,gemini,vertex}.md + CHANGELOG.md |
| F — 명시 cachedContents | ⏸ deferred | 워크로드 측정 후 ROI 결정 |
| G — 멀티모달 | ⏸ deferred | 별도 트랙 |
| 테스트 (사용자 요청 생략) | n/a | 480 회귀 통과로 안전망 유지 |

**누적 LOC**: ~2,000 신규 (plan v3 추정 ~3,195 대비 -37% — Phase B의 정규화기 추출, gemini-shared 100% 재사용, 기존 인프라 활용 효과).

---

---

## 1. 현재 시스템 능력 표면

엔진이 OAuth 3종에 대해 보장하는 기능 — 신규 어댑터의 parity 기준.

### 1.1 코어 프로토콜
- 엔진 정규형: `ChatMessage` (OpenAI Chat shape) / `ToolSpec` / `StreamDelta`. 어댑터는 `AsyncIterable<StreamDelta>`만 노출.
- StreamDelta 종류: `text` / `tool_call` / `usage` / `native_tool` / `stop`.
- `splitSystem` (Anthropic 전용): system 메시지를 conversation에서 떼어 별도 필드로.
- `_ts` (microcompact): 엔진 내부 invariant. `buildMessages`가 어댑터 진입 전에 strip.

### 1.2 컨텍스트 캐싱
- **claude-code**: `cache_control: { type: 'ephemeral' }` 마커 3개 (system, tools[last], messages[last block]).
- **codex**: `attach_item_ids` 전략 (`previous_response_id` 우회). chatgpt.com/backend-api 한정 우회.
- **copilot**: noop. 서버 auto-cache.
- usage delta: `input_tokens` (fresh only), `output_tokens`, `cache_read_tokens`, `cache_write_tokens`.
- **TTL 주의 (2026-03-06 변경)**: Anthropic ephemeral cache의 default TTL이 1h → 5min으로 비공식 변경됨. `microcompact.STALE_AFTER_MS = 5min`이 우연히 일치해 영향 없음. 긴 세션에서 명시적 1h 복원이 필요하면 `cache_control: { type: 'ephemeral', ttl: '1h' }` 옵션 사용 (§4.10).
- **워크스페이스 격리 (2026-02-05)**: prompt cache key가 organization → workspace 단위로 격리됨. `claude-code` ↔ `anthropic` api_key는 다른 워크스페이스 ID로 매핑되므로 cross-provider fork는 cache miss 확정 (§13 결정과 일관 — 이유는 "토큰 소스 다름"이 아니라 워크스페이스 격리).

### 1.3 네이티브 web_search
- **claude-code**: `web_search_20250305` (Anthropic 호스티드, max_uses=5).
- **codex**: `{ type: 'web_search' }` + SSE 라이프사이클 + 인용 캡처.
- **copilot**: 미지원.
- Codex만 transient 소켓 드랍 1회 retry-with-native-off.

### 1.4 Reasoning
- **claude-code**: `interleaved-thinking-2025-05-14`, `redact-thinking-2026-02-12` 베타.
- **codex**: `reasoning: { effort, summary }` + `include: ['reasoning.encrypted_content']` + `attach_item_ids`로 라운드간 anchor 유지.
- **copilot**: 없음.

### 1.5 Fork (`delegate_parallel`)
- `engine/fork.ts:111` — `child.provider_id === 'claude-code'` 단일 가드. 6-gate 중 #2.
- prefix-cache byte-identity (`useExactTools` + `overrideSystem`).

### 1.6 재시도 / 오류
- claude-code: 429/529/5xx exponential backoff, max 2회.
- codex: socket drop 1회 (검색 비활성 fallback).
- copilot: 없음.

### 1.7 Pricing / Window / Catalog
- `usage/pricing.ts` PATTERN_PRICING (모델 id 기반 글롭).
- `usage/contextWindow.ts` (provider, model) → {input, output} 하드코딩.
- `providers/models.ts` claude-code/codex 하드코딩, copilot 동적, anthropic 하드코딩(이미 추가).

---

## 2. 아키텍처 결정

### 2.1 자체 어댑터 유지 (Vercel AI SDK 미도입)
**결정**: 현 패턴 유지. 근거 — 캐싱 마커 위치, reasoning anchor 우회, fork prefix-cache byte-identity, 검색 라이프사이클 합성 같은 픽셀 컨트롤이 SDK 추상화 뒤로 숨음.

### 2.2 공통 헬퍼 추출
- **`providers/openai-response-shared.ts` (신규)**: Codex SSE 정규화기를 추출. Codex/OpenAI api_key 양쪽 호출. **§6에 인터페이스 상세**.
- **`providers/gemini-shared.ts` (신규)**: Gemini wire 빌더 + SSE 파서. Gemini/Vertex 양쪽이 import.
- **`providers/retry.ts` (신규)**: 공통 backoff 헬퍼. 모든 어댑터 사용.
- **`providers/errors.ts` (신규)**: `ProviderError` 클래스. 어댑터 에러 정규화.
- **`providers/tool-translation.ts` (신규)**: `ToolSpec` → 각 provider native shape 변환 + MCP 호환성 검증.

### 2.3 신규 의존성
- `google-auth-library` 추가 (Vertex 서비스 계정). 직접 RS256 서명 대비 ~120 LOC 절감 + 검증된 만료/갱신.
- 그 외 SDK 추가 없음.

---

## 3. 프로바이더별 매핑 (최신 검증 Apr 2026)

### 3.1 Anthropic api_key — 목표 ~99%

| 차원 | 동작 | 메모 |
|---|---|---|
| 엔드포인트 | `POST https://api.anthropic.com/v1/messages` | OAuth와 동일 |
| 인증 | `x-api-key: <key>` + `anthropic-version: 2023-06-01` + `anthropic-beta: ...` | OAuth `Authorization: Bearer` 분기. refresh 없음 |
| 캐싱 | `AnthropicCachingStrategy` 100% 재사용 | ephemeral 마커 위치 동일 |
| Web search | `web_search_20250305` 100% 재사용 | |
| Reasoning | interleaved-thinking, redact-thinking 100% 재사용 | |
| Fork | prefix-cache 동일 메커닉 | `fork.ts:111` 가드에 `'anthropic'` 추가 |
| 재시도 | 429/529/5xx 동일 | 공통 retry 헬퍼로 추출 |

**베타 헤더 분리** — api_key 전용 상수 `ANTHROPIC_BETA_APIKEY`:

| 베타 | OAuth | api_key | 결정 |
|---|:---:|:---:|---|
| `claude-code-20250219` | ✅ | ❌ | api_key 제외 (Claude Code 페르소나 전용) |
| `oauth-2025-04-20` | ✅ | ❌ | 제외 |
| `interleaved-thinking-2025-05-14` | ✅ | ✅ | 유지 |
| `context-management-2025-06-27` | ✅ | ✅ | 유지 |
| `prompt-caching-scope-2026-01-05` | ✅ | ✅ | 유지 |
| `advanced-tool-use-2025-11-20` | ✅ | ✅ | 유지 |
| `effort-2025-11-24` | ✅ | ✅ | 유지 |
| `structured-outputs-2025-12-15` | ✅ | ✅ | 유지 |
| `fast-mode-2026-02-01` | ✅ | ⚠️ 계정별 | Phase 0 probe로 시도, 실패 시 제외 |
| `redact-thinking-2026-02-12` | ✅ | ✅ | 유지 |
| `token-efficient-tools-2026-03-28` | ✅ | ✅ | 유지 |
| `web-search-2025-03-05` | ✅ | ✅ | 유지 |
| `output-300k-2026-03-24` (Apr 2026 신규) | ⚠️ | ⚠️ | Phase 0 probe |
| `managed-agents-2026-04-01` (Apr 2026 신규) | n/a | n/a | OpenHive 대상 아님 — 미사용 |
| `context-1m-2025-08-07` | ⚠️ | ⚠️ | **2026-04-30 retire — 즉시 제거**. 모델 카탈로그·`contextWindow.ts`의 `[1m]` 변형도 정리 |

**1M context 폐지 처리 (2026-04-30)**:
- `apps/web/lib/server/providers/claude.ts`의 `ANTHROPIC_BETA` 리스트에서 `context-1m-*` 미포함 확인 (현재 미포함, OK).
- `usage/contextWindow.ts`의 claude-code 블록에서 `claude-opus-4-7[1m]` 류 항목 grep 후 제거 또는 `legacy: true` 마킹.
- 모델 카탈로그(`providers/models.ts`)에서 `[1m]` suffix 모델 제거.

### 3.2 OpenAI api_key (Responses API) — 목표 ~85%

| 차원 | 동작 | 메모 |
|---|---|---|
| 엔드포인트 | `POST https://api.openai.com/v1/responses` | Codex의 `chatgpt.com/backend-api/codex/responses`와 다름 |
| 인증 | `Authorization: Bearer <key>` | `chatgpt-account-id`/`originator` 헤더 제거 |
| 캐싱 | `previous_response_id + store: true` (정식 경로) | Codex의 `attach_item_ids` 우회 사용 안 함 |
| Web search | `{ type: 'web_search' }` 툴 — **모델 화이트리스트 필수** | §3.2.1 |
| Reasoning | `reasoning: { effort, summary }` + `include: ['reasoning.encrypted_content']` | 그대로 |
| Fork | auto-cache (1024+ token stable prefix) | 비결정론적, 워닝과 함께 허용 |

#### 3.2.1 Web search 모델 화이트리스트 (Apr 2026 검증)

Responses API에서 호스티드 `web_search` 지원 (2026-04-30 검증, developers.openai.com):
- `gpt-5.5` ✅ (default)
- `gpt-5.4`, `gpt-5.4-mini` ✅ — 2026-03 출시 시점부터 web_search 정식 지원 (FluxHire.AI 가이드, OpenRouter 카탈로그 확인)
- `gpt-5` ✅ (단, `effort='minimal'` 시 OFF)
- `gpt-5-mini` ✅
- `gpt-5-search-api`, `gpt-5-search-api-2026-10-14` ✅ (검색 특화 변형)
- `gpt-4o`, `gpt-4o-mini` ✅
- `gpt-4o-search-preview`, `gpt-4o-mini-search-preview` ✅ (Chat Completions API용; Responses에서도 가능)

→ `providers/models.ts`의 OPENAI_MODELS 카탈로그에 `supportsNativeSearch: bool` 플래그. dispatch 시 모델별 게이팅.

#### 3.2.2 모델 카탈로그 (Apr 2026, openai.com/ko-KR/api/ 검증)

| 모델 | 입력 $/1M | 출력 $/1M | Cached In $/1M | 컨텍스트 | 최대 출력 | 컷오프 | 비고 |
|---|---:|---:|---:|---:|---:|---|---|
| `gpt-5.5` | 5.00 | 30.00 | **0.50** | 1,050,000 | 130,000 | 2025-12-01 | **default**, search ✅, **>272k 시 입력 2× / 출력 1.5×** |
| `gpt-5.4` | 2.50 | 15.00 | 0.25 | 1,050,000 | 130,000 | 2025-08-31 | search ✅, **>272k 시 입력 2× / 출력 1.5×** |
| `gpt-5.4-mini` | 0.75 | 4.50 | 0.075 | 400,000 | 130,000 | 2025-08-31 | search ✅ |
| `gpt-5-mini` | (기존) | (기존) | (기존) | (기존) | (기존) | (기존) | search ✅, cheap-model 후보 |

**카탈로그 정책 (codex와 동일 셋)**: openai api_key는 codex와 같은 4 모델 — `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5-mini`. 차이는 인증·엔드포인트뿐:
- codex: `chatgpt.com/backend-api/codex/responses` + ChatGPT OAuth + `attach_item_ids` 우회
- openai: `api.openai.com/v1/responses` + `Authorization: Bearer <key>` + `previous_response_id + store: true`
- ~~`gpt-5`, `gpt-5.5-pro`, `gpt-4o`, `gpt-4o-mini`~~ — 카탈로그 제외 (codex/openai 모두). 결과적으로 `effort='minimal'` 게이트(§4.1.2)도 단순화 가능 — `gpt-5.4`/`gpt-5.5`는 reasoning 모델이지만 minimal 옵션 부재.

**Tiered pricing (>272k input tokens) — 가격 모델 변경**:

`usage/pricing.ts`의 `ModelRates`가 평면 단가 가정. GPT-5.5 / 5.4는 세션 누적 입력이 272,000 토큰 초과 시 단가 곱셈 적용. 미반영 시 비용 50% 미달 표시.

```ts
interface ModelRates {
  input: number
  output: number
  cached_input?: number
  // GPT-5.5/5.4 류: 세션 입력 누적 > threshold 시 곱셈 적용
  long_context_threshold?: number       // 272_000
  long_context_input_multiplier?: number // 2
  long_context_output_multiplier?: number // 1.5
}
```

`computeCost()`에 분기 추가 (`pricing.ts` +20 LOC). 테스트 픽스처: 272k 미만 / 정확히 272k / 초과 3개 케이스.

```ts
OPENAI_MODELS = [
  { id: 'gpt-5.5',       label: 'GPT-5.5',       default: true, supportsNativeSearch: true },
  { id: 'gpt-5.4',       label: 'GPT-5.4',       supportsNativeSearch: true },
  { id: 'gpt-5.4-mini',  label: 'GPT-5.4 mini',  supportsNativeSearch: true },
  { id: 'gpt-5-mini',    label: 'GPT-5 mini',    supportsNativeSearch: true, cheapModel: true },
]

CODEX_MODELS = [  // 동일 4종 (기존 5.5-pro/gpt-5 제거)
  { id: 'gpt-5.5',       label: 'GPT-5.5',       default: true },
  { id: 'gpt-5.4',       label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini',  label: 'GPT-5.4 mini' },
  { id: 'gpt-5-mini',    label: 'GPT-5 mini' },
]
```

→ `usage/pricing.ts`에 명시 단가 3종(gpt-5.5, gpt-5.4, gpt-5.4-mini)+ gpt-5-mini 추가.
→ `usage/contextWindow.ts`의 `'openai': {...}` 블록에 1.05M / 400k context window 정확히 반영.

### 3.3 Google Gemini (api_key) — 목표 ~70%

| 차원 | 동작 | 메모 |
|---|---|---|
| 엔드포인트 | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` | |
| 인증 | `x-goog-api-key: <key>` 헤더 | URL 노출 회피 |
| Wire | `{ systemInstruction, contents, tools, toolConfig, generationConfig, safetySettings }` | OpenAI/Anthropic과 완전 다름 |
| 스트리밍 | SSE `data: { candidates, usageMetadata }` | content_block_* 없음 |
| 캐싱 | `cachedContents` 별도 API | **Phase D 미지원** (Phase F로 분리) |
| Web search | `tools: [{ googleSearch: {} }]` (Gemini 2.0+) | 라이프사이클 없음 → §4.1.4 합성 |
| Reasoning | **Gemini 3에서 `thinkingLevel`로 마이그레이션** (구 `thinkingBudget` 폐기 예정) | **Thought Signatures로 라운드간 chaining 가능 (§3.3.1)** |
| Fork | 캐시 객체 모델 — prefix-cache 부적합 | **Phase D 비활성** |

#### 3.3.1 Thought Signatures (Gemini 3 stateful reasoning) — **신규 (검토에서 발견)**

Gemini 3은 reasoning 연속성을 위해 `thoughtSignature` 필드를 SSE에 emit. Codex의 `attach_item_ids` + `reasoning.encrypted_content` + 다음 라운드 echo 패턴과 동일.

**캡처**: `gemini-shared.ts` 파서가 응답 parts의 `thoughtSignature: string` 필드 발견 시 per-call Map(`chainKey → signatures[]`)에 저장.

**Echo**: 다음 라운드 요청 시 같은 위치(part 인덱스 동일)에 echo. 누락 시 reasoning 연속성 깨져 multi-turn 품질 저하.

**책임 분할**:
- `gemini-shared.ts`: 캡처/echo 로직 (+60 LOC)
- `gemini.ts` / `vertex.ts`: chainKey 전달
- `caching.ts`: `GeminiCachingStrategy`(stub)에 signature scratch 캡처 hook 추가

미반영 시 영향: Gemini 3 multi-turn에서 이전 턴 reasoning 손실 → 답변 품질 큰 폭 하락.

**주요 변경 (Apr 2026 검증)**:
- Gemini 3은 `thinkingBudget` → `thinkingLevel` (low/medium/high) 마이그레이션. 어댑터에서 둘 다 지원하되 모델 id 따라 분기.
- Grounding with Google Search 가격: $14 / 1k 검색 (이전 $35/1k에서 인하).

**Reasoning 정책**:
- `effort` 매핑: low → `thinkingLevel: low` (또는 `thinkingBudget: 0~512`), medium → medium, high → high.
- parts에 `thought: true` 마킹된 텍스트는 **transcript 비노출** (raw chain-of-thought UX 저하 방지).

**Safety**:
- `safetySettings`을 `BLOCK_ONLY_HIGH`로 명시 — 미지정 시 보수적 SAFETY 차단으로 코드 어시스턴트 워크로드 막힘.

**모델 카탈로그** (3종 — 2.5 제거, 3 계열만):
```ts
GEMINI_MODELS = [
  { id: 'gemini-3.1-pro',        label: 'Gemini 3.1 Pro',        default: true, supportsNativeSearch: true, supportsThinking: true, supportsThoughtSignatures: true },
  { id: 'gemini-3-flash',        label: 'Gemini 3.0 Flash',                     supportsNativeSearch: true, supportsThinking: true, supportsThoughtSignatures: true, cheapModel: true },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite',                supportsNativeSearch: true, supportsThinking: true, supportsThoughtSignatures: true },
]

VERTEX_MODELS = [  // Vertex AI는 동일 카탈로그 (gemini-shared.ts 재사용)
  { id: 'gemini-3.1-pro',        label: 'Gemini 3.1 Pro',        default: true },
  { id: 'gemini-3-flash',        label: 'Gemini 3.0 Flash' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
]
```

**티어 구분**:
- `gemini-3.1-pro` — 최상위. Deep Think Mini 포함. 기본 default.
- `gemini-3-flash` — 중간 가격대 flash 라인. cheap-model 폴백 (title/summary/result-cap에서 사용).
- `gemini-3.1-flash-lite` — 최저가/저지연. 단순 분류·라우팅·필터 작업용.

**Gemini 2.5 제거 근거**: Gemini API에서 **2026-06-17 retire** (Phase D 머지 W3-W5 시점에 retire까지 ~3주). Vertex는 2026-10-16. 카탈로그에 노출하면 retire 직후 silent fail.

**Vertex 동일 카탈로그**: 어댑터가 `gemini-shared.ts`를 재사용 — 모델 ID/wire가 동일. Vertex의 retire 일정이 늦지만(2026-10-16) 코드 단순화 위해 통일.

### 3.4 Vertex AI — 목표 ~70%

| 차원 | 동작 | 메모 |
|---|---|---|
| 엔드포인트 | `POST https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent` | location=`global` → host `aiplatform.googleapis.com` (no prefix) |
| 캐싱 엔드포인트 (Phase F) | `https://{location}-aiplatform.googleapis.com/vertex_ai/v1/projects/{project}/locations/{location}/cachedContents` | **`/vertex_ai/v1/`** prefix — Gemini와 다름 |
| 인증 | service-account JSON → JWT(RS256) → `oauth2.googleapis.com/token` 교환 → `Authorization: Bearer <access_token>` (1h) | `google-auth-library` 사용 |
| Wire | Gemini와 100% 동일 | `gemini-shared.ts` 재사용 |

**서비스 계정 JSON 저장**: `tokens.access_token` 필드에 JSON 문자열. 매 호출 시 parse → `google-auth-library`의 `JWT` client 캐시. access_token TTL은 라이브러리가 자동 갱신.

**리전**: `project_id`는 JSON에서 자동, `location`은 사용자 입력 (default `us-central1`). UI에 region 드롭다운 필요 (§4.13).

---

## 4. 횡단 관심사 (Cross-Cutting)

### 4.1 네이티브 검색 정책

**원칙**: function-tool `web-search`/`web-fetch` 스킬은 스크래핑·captcha 한계 명확. provider 호스티드 검색을 1차 경로로 강제, 함수형은 fallback.

#### 4.1.1 Default 정책
- ON: `claude-code`, `anthropic`, `codex`, `openai` (지원 모델 한정), `gemini`, `vertex-ai`.
- OFF: `copilot`.

#### 4.1.2 모델 게이트
`engine/providers.ts`에 `supportsNativeSearch(providerId, model, opts?: { effort?: string }): boolean`:
- claude-code/anthropic: 모든 Claude 4.x ✅
- codex: gpt-5/5.4/5.5 계열 ✅ (Codex는 `effort` 파라미터 무관)
- openai: 카탈로그 메타 `supportsNativeSearch` 플래그 + **`effort='minimal'` 시 `gpt-5`만 OFF** (검증: web_search not supported in gpt-5 with minimal reasoning)
- gemini/vertex-ai: Gemini 3.x ✅ (2.5는 카탈로그에서 제거됨)

**effort 게이트 구현**:
```ts
function supportsNativeSearch(provider: string, model: string, opts?: { effort?: string }): boolean {
  if (provider === 'openai' && model === 'gpt-5' && opts?.effort === 'minimal') return false
  // ... 나머지 카탈로그 메타 참조
}
```

#### 4.1.3 라이프사이클 정규화

모든 어댑터가 동일 `native_tool` StreamDelta 시퀀스 발행:
1. `{ kind: 'native_tool', tool: 'web_search', phase: 'searching', query? }`
2. (선택) 추가 페이즈
3. `{ kind: 'native_tool', tool: 'web_search', phase: 'completed', sources: [...] }`

| Provider | raw 신호 | 정규화 |
|---|---|---|
| Anthropic | `server_tool_use` / `web_search_tool_result` | 시작 = server_tool_use, 완료 = result |
| Codex | `response.web_search_call.*` + action items | 기존 코드 유지 |
| OpenAI api_key | Codex와 동일 SSE 모양 | 정규화기 재사용 |
| Gemini | **이벤트 없음.** `groundingMetadata` | **합성**: 첫 chunk → `searching`, completed 시 → `completed` + sources |
| Vertex | Gemini와 동일 | 동일 합성 |

#### 4.1.4 Fallback
- transient(소켓 드랍, 5xx): 1회 retry with native off → 모델이 함수형 `web-search` 사용
- Anthropic 429/5xx: 기존 backoff 재시도 후 throw

#### 4.1.5 사용자 컨트롤
에이전트 설정에 per-agent native search 토글 (default ON). 회사 정책상 외부 검색 차단 케이스 대응.

#### 4.1.6 Native vs Skill 검색 예산 분리 — **신규 (검토에서 발견)**

현재 엔진 `session.ts`의 `max_web_search_per_turn=5` 캡이 **native와 함수형(skill) 호출을 합산**. §4.1.4 폴백 정책이 "native 실패 → skill"인데 합산 카운터면:
- native 5회 도달 후 skill 폴백도 차단 (의도와 반대)
- native 1~4회 + skill 1회로 의도와 어긋남

**조치**: 카운터 분리.
```ts
// session.ts perTurnCaps
{
  nativeSearchCount: number,  // provider hosted (web_search_20250305 / responses web_search / googleSearch)
  skillSearchCount: number,   // function-tool web-search skill
}
// 각각 별도 cap (default native=8, skill=5)
```

`engine/session.ts` +20 LOC. resetPerTurnCaps()에 두 카운터 모두 reset. UI 디버그 패널에 분리 표시.

### 4.2 멀티모달 정책

현재 OAuth 어댑터 검사 결과 — `providers/*.ts`에 image/multimodal 처리 0건. **시스템 전체가 text-only**.

→ **신규 어댑터도 v1은 text-only**. 멀티모달은 Phase G(별도 트랙)에서 모든 provider 동시 도입. parity 손실 없음.

향후 추가 시 영향 범위:
- `ChatMessage.content` 타입 확장 (string → string | (Text | Image)[])
- `tool-translation.ts`에 image part 변환 추가
- 4종 모두 image 지원 OK (Anthropic vision, OpenAI vision, Gemini multimodal, Vertex multimodal)

### 4.3 MCP 툴 호환성

엔진의 `ToolSpec` (OpenAI Chat shape)을 각 provider native shape으로 변환. **Gemini만 OpenAPI subset 제약** — 사전 검증 필요.

#### 4.3.1 변환기 위치
`providers/tool-translation.ts` (신규):
```ts
export function toAnthropic(tools: ToolSpec[]): AnthropicTool[]
export function toResponses(tools: ToolSpec[]): ResponsesTool[]   // codex/openai 공유
export function toGemini(tools: ToolSpec[]): GeminiFunctionDecl[] // gemini/vertex 공유
```

#### 4.3.2 Gemini 제약
- OpenAPI 3.0 subset만 — `oneOf`/`anyOf`/`allOf` 부분 지원, `$ref` 미지원
- 대응: 변환기에서 `$ref` 만나면 inline 해석 시도, 실패 시 해당 툴 skip + 경고 로그

#### 4.3.3 검증 테스트
`tool-translation.test.ts`: 현재 MCP 툴 카탈로그 전체를 4 provider에 통과시켜 변환 실패율 측정. 임계치: skip율 5% 이내.

### 4.4 Rate limit / 동시성

#### 4.4.1 Provider별 제한 (Apr 2026)
| Provider | RPM (typical) | TPM | 비고 |
|---|---|---|---|
| Anthropic | tier별 50~4000 | 40k~400k | 429에 `retry-after` 헤더 |
| OpenAI | tier별 500~10000 | 30k~30M | 429에 `Retry-After` |
| Gemini | 무료 15, 유료 1000 | 1M | 429 + `RESOURCE_EXHAUSTED` |
| Vertex | 프로젝트·리전 quota | 동일 | 429 |

#### 4.4.2 공통 retry 헬퍼
`providers/retry.ts`:
```ts
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseMs?: number; on429RespectHeader?: boolean },
): Promise<T>
```
- 모든 어댑터가 사용. 기존 claude.ts의 인라인 backoff 제거.

#### 4.4.3 Provider-level 동시성 캡
- `providers/semaphore.ts` (신규): provider id별 active call counter.
- default 10 (env `OPENHIVE_<PROVIDER>_CONCURRENCY` override).
- 초과 시 대기열 (timeout 30s).
- 안 깎아도 fatal 아님 — 1차 출시는 retry로만 대응, semaphore는 v2로 deferred 가능.
- **예외 — Vertex AI는 v1부터 default ON**: region·project quota가 좁고 burst 시 즉시 429 노출. default cap = 6 (`OPENHIVE_VERTEX_CONCURRENCY` override).

### 4.5 에러 정규화

`providers/errors.ts` (신규):
```ts
export type ProviderErrorKind =
  | 'auth'              // 401/403
  | 'quota'             // 429 with persistent failure
  | 'unsupported_model' // 404 model
  | 'geo_restricted'    // 403 with region indicator
  | 'transient'         // 5xx, network
  | 'unknown'

export class ProviderError extends Error {
  kind: ProviderErrorKind
  userMessage: string  // i18n key
  cause?: unknown
}
```

각 어댑터 catch → `ProviderError` 던짐. 엔진 `session.ts`의 에러 핸들러가 `userMessage`를 i18n으로 풀어 UI에 표시.

**API 키 redact (필수)**: `errors.ts`에 `redactCredentials(text: string): string` 헬퍼 추가. `ProviderError.message` / `cause.message` / stack의 다음 패턴 마스킹:
- `sk-ant-api03-[A-Za-z0-9_-]+` → `sk-ant-api03-***`
- `sk-[A-Za-z0-9]{20,}` → `sk-***` (OpenAI)
- `AIza[A-Za-z0-9_-]{35}` → `AIza***` (Gemini)
- `Bearer ya29\.[A-Za-z0-9_-]+` → `Bearer ya29.***` (Vertex access_token)
- `key=[A-Za-z0-9_-]+` (쿼리스트링 fallback)
- `Authorization: Bearer ...`, `x-api-key: ...`, `x-goog-api-key: ...` 헤더 라인

`ProviderError` 생성 시점에 자동 적용. 이벤트 라이터·로그·UI 모든 경로에 같은 함수 통과. probe 스크립트(§6.6)와 동일 redact 함수 재사용.

신규 i18n 키:
- `error.provider.auth`: "API 키가 유효하지 않습니다. Settings에서 다시 등록하세요."
- `error.provider.quota`: "{provider} 사용량 한도에 도달했습니다."
- `error.provider.unsupported_model`: "{model}은(는) 더 이상 지원되지 않습니다."
- `error.provider.geo_restricted`: "{provider}은(는) 현재 지역에서 사용 불가입니다. Vertex AI를 시도해보세요."
- `error.provider.transient`: "일시적 오류. 잠시 후 다시 시도하세요."

### 4.6 Cancel / abort

엔진 `session.ts:3465`에 `signal?: AbortSignal` 이미 존재. 어댑터에 전달되는지 확인 필요.

`StreamOpts`에 `signal: AbortSignal` 추가. 어댑터 `fetch()`에 그대로 전달:
```ts
fetch(url, { ..., signal: opts.signal ?? AbortSignal.timeout(timeoutMs) })
```
사용자 cancel 시 fetch 중단 → SSE reader 중단 → finally에서 `{ kind: 'stop', reason: 'aborted' }` emit.

기존 OAuth 어댑터도 이 시그니처로 통일 (기술 부채 청산).

### 4.7 Vertex 보안

#### 4.7.1 Service-account JSON 검증
업로드 시 Zod 스키마로 검증 후 저장:
```ts
const ServiceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string(),
  private_key_id: z.string(),
  private_key: z.string().startsWith('-----BEGIN PRIVATE KEY-----'),
  client_email: z.string().email(),
  // ...
})
```
실패 시 즉시 reject + UI 에러.

#### 4.7.2 디스크 권한
`tokens.ts`가 사용하는 파일에 `chmod 0600` 강제 (이미 그런지 확인 후 보강).

#### 4.7.3 캐시 무효화
`POST /api/providers/:id` disconnect 시:
- `tokens.deleteToken(id)`
- 신규 hook: `clearProviderCache(id)` — 글로벌 Map들 (`__openhive_codex_session`, `__openhive_openai_response_chain`, `__openhive_vertex_auth`) 정리.

### 4.8 마이그레이션 / 충돌

#### 4.8.1 동시 등록 OK
- claude-code OAuth + Anthropic api_key 동시 활성 가능. 별도 토큰 슬롯.
- 에이전트는 `provider_id`로 식별 — 충돌 없음.

#### 4.8.2 모델 카탈로그 dedup
- `claude-opus-4-7`이 claude-code와 anthropic 양쪽에 존재 — UI에서 `<provider_label> / <model_label>` 형식으로 표시:
  - "Claude Code / Opus 4.7"
  - "Anthropic / Opus 4.7"
- 동작은 같지만 토큰 소스가 다름 → 사용자가 명시적 선택.

#### 4.8.3 default 에이전트
신규 회사 생성 시 default provider 우선순위:
1. `codex` (연결됨)
2. `claude-code` (연결됨)
3. `copilot` (연결됨)
4. `anthropic` (연결됨)
5. `openai` (연결됨)
6. ...

OAuth 우선 — 무료/구독 활용.

### 4.9 Cheap-model 폴백 (title / summary / result-cap) — **신규 (검토에서 발견)**

**문제**: 다음 코드 경로가 모델을 호출하는데 provider-bound:
- `apps/web/lib/server/sessions/title.ts` — 자동 타이틀 (현재 `gpt-5-mini` 하드코딩, 10s deadline, fire-and-forget)
- `apps/web/lib/server/engine/history-window.ts` — 40턴 초과 시 `summarise()` (agent의 provider+model 사용 추정)
- `apps/web/lib/server/engine/result-cap.ts` — child 100k자 초과 시 LLM 요약 (`pickSummaryModel(node)`)

사용자가 Anthropic api_key 만 등록하면:
- 타이틀: Codex 미연결 → 호출 실패, 타이틀 누락 (silent)
- summarise: agent의 비싼 모델로 요약 → 비용 ↑
- result-cap LLM: 동일

**해결**: `providers/cheap-model.ts` 신규 헬퍼 (+40 LOC).
```ts
interface CheapModelChoice {
  providerId: string
  model: string
}

// 카탈로그 메타에 cheapModel 플래그 추가
// claude-code/anthropic: 'claude-haiku-4-5'
// codex/openai: 'gpt-5-mini' / 'gpt-5.5-mini'(있다면)
// gemini/vertex-ai: 'gemini-3-flash'
// copilot: dynamic — 'gpt-4o-mini' fallback
export function pickCheapModel(connectedProviders: string[]): CheapModelChoice | null {
  const order = ['codex', 'openai', 'claude-code', 'anthropic', 'gemini', 'vertex-ai', 'copilot']
  for (const p of order) {
    if (connectedProviders.includes(p)) return { providerId: p, model: cheapModelFor(p) }
  }
  return null
}
```

**호출부 패치 (+15 LOC 합)**:
- `title.ts:generateTitle()` — `gpt-5-mini` 하드코딩 제거, `pickCheapModel()` 결과 사용
- `history-window.ts:summarise()` — agent 모델 대신 cheap-model
- `result-cap.ts:pickSummaryModel(node)` — provider 미연결 시 cheap-model 폴백

미연결 시 `null` 반환 → 호출부가 graceful skip (요약 없이 truncate, 타이틀 없이 진행).

### 4.10 Anthropic 1h TTL 옵션 — **신규 (검토에서 발견)**

2026-03-06부로 ephemeral cache default TTL이 5min. 긴 세션(>5min idle 후 재개)에서 cache miss 누적.

**조치**: `AnthropicCachingStrategy`에 `ttl?: '5m' | '1h'` 옵션 추가. 기본 `'5m'` 유지(현 동작 보존). 명시적 1h 사용 케이스:
- 회사 단위로 긴 idle 세션이 빈번하면 team config에 `cache_ttl: '1h'` 설정
- microcompact 비활성된 에이전트 (db_exec 위주 trajectory)
```ts
// caching.ts
const cacheControl = ttl === '1h'
  ? { type: 'ephemeral', ttl: '1h' }
  : { type: 'ephemeral' }
```
+10 LOC. 1h TTL 사용 시 비용 1.25× → 2× 캐시 write 비용 인지 필요(문서화).

---

## 5. 파일·LOC 플랜

### 5.1 신규 파일

| 파일 | 목적 | LOC |
|---|---|---|
| `apps/web/lib/server/providers/openai.ts` | OpenAI Responses API 클라이언트 | 220 |
| `apps/web/lib/server/providers/gemini.ts` | Gemini API 클라이언트 (래퍼) | 80 |
| `apps/web/lib/server/providers/gemini-shared.ts` | wire 빌더 + SSE 파서 (Gemini/Vertex 공용) | 380 |
| `apps/web/lib/server/providers/vertex.ts` | Vertex 엔드포인트·인증 래퍼 | 130 |
| `apps/web/lib/server/auth/vertex.ts` | service-account JSON → access_token | 60 |
| `apps/web/lib/server/providers/openai-response-shared.ts` | Codex/OpenAI 공통 SSE 정규화기 (§6) | 200 |
| `apps/web/lib/server/providers/retry.ts` | 공통 backoff 헬퍼 | 50 |
| `apps/web/lib/server/providers/errors.ts` | `ProviderError` + 분류 헬퍼 | 70 |
| `apps/web/lib/server/providers/tool-translation.ts` | ToolSpec → 4 provider 변환 + MCP 검증 + Responses strict 검증 | 200 |
| `apps/web/lib/server/providers/cheap-model.ts` | title/summary/result-cap용 cheap-model 폴백 (§4.9) | 40 |
| `apps/web/scripts/probe-anthropic-apikey.ts` | Phase 0 probe | 60 |
| `apps/web/scripts/probe-openai-apikey.ts` | Phase 0 probe | 70 |
| `apps/web/scripts/probe-gemini.ts` | Phase 0 probe | 70 |
| `apps/web/scripts/probe-vertex.ts` | Phase 0 probe | 80 |

**신규 합계: 1,710 LOC** (cheap-model 40 + tool-translation +20)

### 5.2 수정 파일

| 파일 | 변경 | LOC |
|---|---|---|
| `providers/claude.ts` | api_key 분기 (헤더, 베타, refresh 우회) | +40 |
| `providers/codex.ts` | 정규화기 호출로 이전, codex 전용 reasoning anchor 콜백 | -100 / +30 (net -70) |
| `providers/caching.ts` | `OpenAIResponsesCachingStrategy`, `GeminiCachingStrategy` + thought-signature scratch hook + Anthropic `ttl` 옵션 (§4.10) | +110 |
| `providers/models.ts` | OPENAI/GEMINI/VERTEX 분기 + 카탈로그 + `supportsNativeSearch`/`supportsThoughtSignatures`/`cheapModel` 메타 + Gemini 2.5 제거 + `[1m]` Claude 제거 | +40 |
| `engine/providers.ts` | dispatch 4개 + `supportsNativeSearch()` + streamCodex 정규화 추출 | +180 |
| `engine/fork.ts:111` | `'claude-code' \| 'anthropic'` 허용 | +5 |
| `engine/session.ts` | `ProviderError` 처리 → UI 메시지 emit | +20 |
| `usage/contextWindow.ts` | 4 블록 추가 + `[1m]` 변형 제거(2026-04-30 retire) | +30 / -5 |
| `usage/pricing.ts` | tiered pricing(>272k) 분기 + cached_input + thinking 단가 + 누락 모델 보강 | +35 |
| `engine/session.ts` | native vs skill search counter 분리 (§4.1.6) + ProviderError UI emit | +40 |
| `sessions/title.ts` / `engine/history-window.ts` / `engine/result-cap.ts` | cheap-model 폴백 적용 (§4.9) | +15 합 |
| `agent-frames.ts` / `frames.ts` | `defaultModelFor` 분기 4개 | +24 |
| `tokens.ts` | api_key 헬퍼 + cache invalidation hook | +20 |
| `auth/providers.ts` | gemini/vertex 메타 검증 (anthropic 이미 추가) | +5 |
| `package.json` | `google-auth-library` | +1 |
| `lib/i18n.ts` | error.provider.* 키 5종 × 2언어 | +20 |

**수정 net: +505 LOC** (검토 권고 반영분 +85)

### 5.3 UI 작업

| 파일 | 변경 | LOC |
|---|---|---|
| `components/settings/sections/ProvidersSection.tsx` | Vertex region 드롭다운, JSON 업로드 UI 강화 | +80 |
| `components/agents/AgentEditor.tsx` (또는 해당 위치) | per-agent native search 토글 | +30 |
| `components/ui/ProviderErrorToast.tsx` (신규) | `ProviderError` 표준 표시 | +50 |

**UI 합계: 160 LOC**

### 5.4 테스트

| 파일 | 내용 | LOC |
|---|---|---|
| `providers/anthropic-apikey.test.ts` | 헤더 분기, 베타 리스트, caching snapshot | 60 |
| `providers/openai.test.ts` | 요청 빌드 snapshot, previous_response_id chain, web_search 게이트 | 100 |
| `providers/openai-response-shared.test.ts` | 정규화기 회귀 (Codex 기존 케이스 + OpenAI) | 80 |
| `providers/gemini.test.ts` | wire 변환, search lifecycle 합성, thinkingLevel | 120 |
| `providers/gemini-shared.test.ts` | 빌더/파서 단위 | 80 |
| `providers/vertex.test.ts` | JWT 흐름 모킹, 엔드포인트, location 라우팅 | 80 |
| `providers/tool-translation.test.ts` | MCP 카탈로그 4 provider 변환 회귀 | 90 |
| `providers/retry.test.ts` | backoff 동작 | 30 |
| `providers/errors.test.ts` | 에러 분류 | 30 |
| `engine/fork.test.ts` | anthropic api_key 케이스 확장 | +20 |
| `engine/providers.test.ts` (신규) | dispatch 매트릭스 + supportsNativeSearch | 60 |

**테스트 합계: 750 LOC**

### 5.5 문서

| 파일 | 내용 | LOC |
|---|---|---|
| `docs/providers/anthropic.md` | 설정, 베타, 모델 | 50 |
| `docs/providers/openai.md` | 설정, web_search 모델, GPT-5.5 노트 | 60 |
| `docs/providers/gemini.md` | 설정, safetySettings, thinkingLevel | 70 |
| `docs/providers/vertex.md` | service-account 만들기, region 선택 | 80 |
| `README.md` | provider 표 갱신 | +10 |
| `CHANGELOG.md` | phase별 항목 | +20 |

**문서 합계: 290 LOC** (마크다운, 코드 LOC와 별개)

### 5.6 LOC 총합

- 코드 신규: **1,710**
- 코드 수정 net: **+505**
- UI: **160**
- 테스트: **820** (검토 권고 회귀 +70)
- **코드 합계: 약 3,195 LOC**
- 문서: 290 LOC (별도)

(앞서 추정 1,500–2,400 범위 상단을 살짝 초과 — 횡단 관심사·테스트·UI를 모두 포함해서.)

---

## 6. Phase B — Codex 정규화기 추출 인터페이스

가장 회귀 위험 높은 단계. 인터페이스를 미리 확정.

### 6.1 위치 / 시그니처

`apps/web/lib/server/providers/openai-response-shared.ts`:

```ts
import type { StreamDelta } from './types'

interface ResponsesNormalizerHooks {
  /** Codex 전용: reasoning item 캡처. OpenAI api_key는 미사용. */
  onReasoningItem?: (item: {
    id: string
    encrypted_content?: string
    summary?: unknown
  }) => void

  /** Codex 전용: function_call의 server-assigned id 캡처. OpenAI api_key는 미사용. */
  onFunctionCallId?: (callId: string, serverItemId: string) => void

  /** 응답 완료 시 commit 신호. Codex가 scratch → state 이전. */
  onResponseCompleted?: () => void
}

/**
 * Responses API SSE → StreamDelta.
 *
 * Codex / OpenAI api_key 양쪽이 호출. 차이는 hooks 유무뿐:
 *  - Codex: hooks 모두 전달, scratch 캡처 → state.commit on completed
 *  - OpenAI api_key: hooks 미사용 (caching은 previous_response_id로 별도)
 *
 * 정규화 책임:
 *  - response.output_text.delta → text
 *  - response.output_item.added (function_call) → tool_call (id 캡처)
 *  - response.function_call_arguments.delta → tool_call (chunk)
 *  - response.web_search_call.{in_progress,searching,completed} → native_tool
 *  - response.output_item.done (web_search_call) → query/sources 캡처
 *  - response.output_text.annotation.added → sources (Codex만 발행)
 *  - response.completed → usage + 최종 native_tool(sources) + stop
 *
 * Caller 책임:
 *  - 요청 빌드 (caching strategy 포함)
 *  - fetch + 헤더 + 인증
 *  - reasoning anchor 상태 관리 (Codex만, hooks로 위임)
 */
export async function* normalizeResponsesStream(
  events: AsyncIterable<Record<string, unknown>>,
  hooks?: ResponsesNormalizerHooks,
): AsyncIterable<StreamDelta>
```

### 6.2 추출 대상 / 비추출 대상

**추출** (`engine/providers.ts:streamCodex`의 line 283–528 내부):
- text/tool_call/usage delta 발행 (line 398–476)
- web_search 라이프사이클 + 쿼리/소스 캡처 (line 329–397, 411–432)
- response.completed 처리 (line 477–524) — usage delta + 최종 native_tool + stop
- extractCompletedMessageText fallback (line 540–555)

**비추출** (Codex 전용, codex.ts 안에 유지):
- attach_item_ids overlay/splice (line 391–426 of codex.ts)
- reasoning/function_call scratch 캡처 → state.commit (line 519–552 of codex.ts)
- transient socket-drop retry-with-native-off (line 432–456 of codex.ts)

→ Codex 어댑터는 `streamResponsesOnce` 내부에서 `sseEvents()` → 자체 scratch 캡처 → `normalizeResponsesStream()`에 hooks 위임.

### 6.3 회귀 차단

- `openai-response-shared.test.ts`에 기존 Codex 픽스처(`apps/web/scripts/probe-native-events.ts`로 캡처한 raw SSE 시퀀스) 전부 복사. 정규화 결과가 byte-equivalent로 같아야 머지.
- 추가로 OpenAI api_key용 픽스처(probe로 신규 캡처) 6~8개.

---

## 7. 구현 순서

### Phase 0 — Probes (선행, 1~2일)
**목적**: 추측 제거. 각 provider 실제 동작 확인.

- `probe-anthropic-apikey.ts`: 베타 헤더 매트릭스 (각 베타 단독 + 조합)로 1턴 round-trip. **`context-1m-2025-08-07` 거부 확인** (2026-04-30 retire), `ttl: '1h'` 동작 확인.
- `probe-openai-apikey.ts`:
  - web_search를 모델별로 round-trip 회귀 (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5`, `gpt-4o`) — 모두 ✅로 가정, 거부 시 카탈로그 메타 즉시 false
  - **`gpt-5` + `reasoning.effort='minimal'` + web_search → 거부 확인**
  - **MCP 카탈로그 → Responses tool `strict: true` 변환 통과율 측정**
- `probe-gemini.ts`: googleSearch + thinkingLevel 시도. groundingMetadata 실제 구조 dump. **응답 parts에 `thoughtSignature` 필드 캡처 → 다음 라운드 echo round-trip 검증**.
- `probe-vertex.ts`: 서비스 계정 1개로 `us-central1`/`global` round-trip + 동시 6개 요청 burst로 quota 동작 관찰.

산출물: `dev/active/api-key-providers/probe-results.md` (raw dump + 결정 갱신).

**Gating**: 사용자가 각 provider 실키 1개씩 임시 제공 (또는 본인 계정).

### Phase A — Anthropic api_key (1주, ~320 LOC)
- claude.ts api_key 분기, 베타 분리 (`context-1m-*` 미포함 확인)
- **`retry.ts` 추출** (검토 권고: Phase B 회귀 risk와 무관하게 선행) + claude.ts 인라인 backoff 마이그레이션
- **`errors.ts` + `redactCredentials()` 헬퍼**
- engine dispatch + fork.ts 가드
- contextWindow(`[1m]` 제거) / pricing(tiered + cached_input) / defaultModelFor
- AnthropicCachingStrategy `ttl` 옵션 (§4.10)
- cheap-model 헬퍼 + title.ts 패치 (Anthropic Haiku 폴백 검증)
- 테스트
- env: `OPENHIVE_PROVIDER_ANTHROPIC=1` 게이팅
- 1주 dogfood → default on

### Phase B — Codex 정규화기 추출 (3일, net -70 LOC)
- `openai-response-shared.ts` 작성
- codex.ts에서 정규화 부분 호출로 교체
- 회귀 테스트 (Codex 기존 픽스처 통과)
- 별도 PR, default on (플래그 없음)

### Phase C — OpenAI api_key (1.5주, ~600 LOC)
- Phase B 의존
- providers/openai.ts + OpenAIResponsesCachingStrategy
- web_search 모델 게이트
- previous_response_id chain Map
- 테스트
- env: `OPENHIVE_PROVIDER_OPENAI=1`

### Phase D — Gemini api_key (2주, ~960 LOC)
- gemini-shared.ts (wire + parser + **thought signatures 캡처/echo, §3.3.1**) + gemini.ts (auth wrapper)
- search 라이프사이클 합성
- thinkingLevel 매핑 (Gemini 3.x 전용 — 2.5 미지원)
- safetySettings BLOCK_ONLY_HIGH default
- 카탈로그: gemini-3.1-pro / gemini-3-flash만 (2.5 retire 대비)
- 테스트 — thought signature 라운드트립 fixture 필수
- 캐싱 미구현 (Phase F)
- env: `OPENHIVE_PROVIDER_GEMINI=1`

### Phase E — Vertex AI (1.5주, ~490 LOC)
- vertex.ts (gemini-shared.ts 재사용 — thought signatures 자동 적용)
- auth/vertex.ts + google-auth-library
- region 드롭다운 UI
- service-account JSON 검증
- **semaphore default-on (cap=6, §4.4.3)**
- 테스트
- env: `OPENHIVE_PROVIDER_VERTEX=1`

### Phase F (선택) — Gemini/Vertex 캐싱 (1.5주, ~250 LOC)
- `cachedContents` API 통합
- 두 엔드포인트 차이 처리 (Gemini = `/v1beta/`, Vertex = `/vertex_ai/v1/`)
- 워크로드 측정 후 결정

### Phase G (선택) — 멀티모달 (별도 트랙, ~600 LOC)
- 4 provider 동시 image input 도입
- ChatMessage.content 타입 확장

---

## 8. 테스트 전략

### 8.1 단위
- caching snapshot (각 strategy)
- wire 변환 함수
- SSE 파서 (픽스처)
- tool-translation MCP 회귀

### 8.2 통합 probe
- Phase 0의 probe 스크립트 — 매 Phase 종료 시 재실행해서 wire shape drift 감지.
- env-gated, CI 미실행.

### 8.3 Fork 회귀
- claude-code → claude-code (기존)
- anthropic → anthropic (신규)
- claude-code ↔ anthropic cross-provider: `provider_mismatch`로 fresh 선택 확인 (cache 안 됨)

### 8.4 Search lifecycle parity
- 4 provider raw 이벤트 → StreamDelta 시퀀스 비교. 동일 모양 확인.

### 8.5 에러 정규화
- 401/429/5xx 시뮬레이션 → ProviderError kind 매트릭스 통과
- **dispatch 레이어 error path 매트릭스**: `engine/providers.test.ts`에 4 provider × {auth, quota, transient, geo} 16케이스 — provider별 정확한 ProviderError emit 회귀
- **redactCredentials 회귀**: `errors.test.ts`에 5종 키 패턴(sk-ant-, sk-, AIza, ya29., x-goog-api-key 헤더) fixture 통과

### 8.7 가격 회귀
- `pricing.test.ts`: GPT-5.5 tiered (272k 미만 / 정확히 / 초과) 3 케이스, cached_input 차감 케이스, 세션 누적 케이스

### 8.8 cheap-model 폴백
- `cheap-model.test.ts`: 우선순위 매트릭스 (codex만 / anthropic만 / 둘 다 / 모두 미연결) 정확한 선택 검증
- title.ts / history-window.ts / result-cap.ts 각각의 graceful skip 회귀

### 8.9 thought signatures (Gemini)
- `gemini-shared.test.ts`: probe로 캡처한 raw SSE fixture에서 `thoughtSignature` 추출 → 다음 요청 echo 위치 정확성 회귀

### 8.6 Live test (env: `OPENHIVE_LIVE_TEST=1`)
- 실키 사용. 각 provider 1턴 round-trip.

---

## 9. 롤아웃

### 9.1 Phase별 환경변수
| 변수 | Phase | 기본값 |
|---|---|---|
| `OPENHIVE_PROVIDER_ANTHROPIC` | A | unset |
| `OPENHIVE_PROVIDER_OPENAI` | C | unset |
| `OPENHIVE_PROVIDER_GEMINI` | D | unset |
| `OPENHIVE_PROVIDER_VERTEX` | E | unset |
| `OPENHIVE_NATIVE_SEARCH_DISABLE` | 모든 | unset |
| `OPENHIVE_LIVE_TEST` | 테스트 | unset |
| `OPENHIVE_<PROVIDER>_CONCURRENCY` | semaphore | 10 |

### 9.2 PROVIDERS UI 업데이트
- 각 Phase 머지 시 해당 provider만 PROVIDERS 배열에 노출.
- 미구현 항목은 배열에서 제외 (silent fail 회피).
- 출시 후엔 default on.

### 9.3 버전
- Phase A 머지 → v0.3.0 (minor: 신규 provider 추가)
- Phase C 머지 → v0.3.x (minor)
- Phase E 머지 → v0.4.0
- Phase F → v0.4.x

### 9.4 Changelog
각 PR에서 `CHANGELOG.md`에 항목 추가.

---

## 10. 캘린더

| 주차 | Phase | 산출물 |
|---|---|---|
| W0 | Phase 0 | probe 결과, 결정 갱신 |
| W1 | Phase A | Anthropic api_key 머지 |
| W1.5 | Phase B | 정규화기 추출 머지 |
| W2~W3 | Phase C | OpenAI api_key 머지 |
| W3~W5 | Phase D | Gemini 머지 |
| W5~W6.5 | Phase E | Vertex 머지 |
| W7+ | (선택) Phase F | 캐싱 — 워크로드 측정 후 |

총 6.5주 (1인). 병렬 작업 시 단축 가능.

---

## 11. 실패 모드 / 롤백

| 시나리오 | 감지 | 롤백 |
|---|---|---|
| Anthropic 베타 거부 | 첫 요청 4xx | 베타 리스트에서 제거, hot patch |
| Codex 정규화 회귀 | 기존 테스트 실패 | revert + inline 복원 |
| OpenAI Responses 변경 | snapshot 실패 | wire 빌더 수정 |
| GPT-5.4 web_search 미지원 | probe 시 400/422 | `supportsNativeSearch: false`로 게이트, 함수형 폴백 |
| Gemini wire 변경 | live probe 실패 | parser 핫픽스 |
| Vertex JWT race | 401 burst | google-auth-library 자동 갱신 검증 |
| Service account 유출 | grep 사고 | 즉시 rotate, 캐시 invalidate |
| Native search 차단 | UI에 검색 결과 0 | `OPENHIVE_NATIVE_SEARCH_DISABLE=1`로 강제 함수형 폴백 |

---

## 12. 결정 사항 (확정)

> 2026-04-30 사용자 확인 + Lead 결정 (사용자가 위임).

1. **Gemini 캐싱**: Phase F로 분리. v1 출시 시점 ~65% parity.
2. **Vertex 인증**: `google-auth-library` 추가.
3. **Gemini 검색 라이프사이클**: 합성 (UI parity 우선).
4. **PROVIDERS UI**: 단계별 등록 (미구현은 배열에서 제외).
5. **GPT-5.5**: OpenAI api_key 카탈로그 default. openai.com 공식 명시(2026-04-30 확인) — 입력 $5/1M, 출력 $30/1M, 컨텍스트 1.05M, 출력 130k, 컷오프 2025-12-01.
6. **Phase 머지 캐던스**: 주 단위 (§10 캘린더).
7. **Native search**: 모든 신규 어댑터 default ON.
8. **Function-tool 폴백**: native 모델 미지원 / transient 오류 시에만.
9. **모델 카탈로그**: 하드코딩 + 메타 플래그 (`supportsNativeSearch`, `default`). 동적 fetch는 v2.
10. **멀티모달**: v1 text-only. Phase G 별도 트랙.
11. **MCP 변환**: `tool-translation.ts`로 일원화. Gemini OpenAPI subset 제약 검증 테스트 필수.
12. **Cancel/abort**: `StreamOpts.signal`로 통일. 기존 OAuth 어댑터도 같이 손봄.
13. **Fork 정책**: `claude-code` + `anthropic` 같은 provider끼리만 fork. cross-provider는 `provider_mismatch`로 fresh — 이유는 **워크스페이스 cache 격리(2026-02-05)**, 토큰 소스 차이 아님.
14. **에러 정규화**: `ProviderError` 클래스 + i18n 키 5종 + **`redactCredentials()` 자동 적용**.
15. **동시성 cap**: provider id별 default 10, env override. **Vertex만 default ON (cap=6)**.
16. **GPT-5.5/5.4 tiered pricing**: `>272k input` 시 입력 2× / 출력 1.5× — `usage/pricing.ts`에 분기 추가. cached_input ($0.50/1M) 별도 단가.
17. **Gemini 카탈로그**: 2.5 제거 (2026-06-17 retire). 3.1 Pro / 3 Flash만.
18. **Anthropic 1M context beta**: `context-1m-2025-08-07` 2026-04-30 retire — 카탈로그·contextWindow에서 즉시 제거.
19. **Gemini Thought Signatures**: `gemini-shared.ts`에 캡처/echo 로직 필수 — 미반영 시 multi-turn reasoning 손실.
20. **Native vs Skill 검색 카운터 분리**: 합산 카운터의 폴백 차단 문제 해결.
21. **Cheap-model 폴백**: title/summary/result-cap이 provider-bound 호출하지 않도록 `pickCheapModel()` 헬퍼 도입.
22. **OpenAI effort='minimal' 게이트**: `gpt-5` + minimal reasoning은 web_search 미지원 — `supportsNativeSearch()` 시그니처에 `effort` 인자 추가.
23. **Anthropic ttl 옵션**: `'5m'` (default) | `'1h'`. 긴 idle 세션 cache 보호용.

---

## 13. 변경 로그

- **2026-04-30 — Lead (v1)**: 초기 plan + context 작성. 14개 갭 식별.
- **2026-04-30 — Lead (v2)**: 14개 갭 모두 메움. 최신 정보 반영(Anthropic 베타, OpenAI web_search 화이트리스트, Gemini thinkingLevel 마이그레이션, Vertex cachedContents 엔드포인트). Phase 0(probes) 신설. 횡단 관심사 §4로 통합. Codex 정규화기 인터페이스 §6 상세. LOC 재추정.
- **2026-04-30 — Lead (v2.1)**: GPT-5.5 정정. openai.com 공식 페이지(ko-KR/api/) 직접 확인 — default 모델 확정. 가격(입력 $5/1M, 출력 $30/1M), 컨텍스트(1.05M), 출력(130k), 컷오프(2025-12-01) 반영. `experimental` 플래그 제거. §3.2.2 모델 카탈로그 표 추가.
- **2026-04-30 — Lead (v3)**: 코드베이스 전수조사 검토 결과 반영. **차단 4건**: (1) GPT-5.5/5.4 tiered pricing(>272k 2×/1.5×) + cached_input — `pricing.ts` 가격 모델 변경, (2) Anthropic `context-1m-*` 베타 2026-04-30 retire — `[1m]` 변형 제거, (3) Gemini 2.5 카탈로그 제거(2026-06-17 retire), (4) Gemini 3 Thought Signatures 캡처/echo 도입 — multi-turn reasoning 연속성. **강력 권고 7건**: (5) cheap-model 폴백 헬퍼 (§4.9) — title/summary/result-cap의 provider-bound 호출 해결, (6) native vs skill search 카운터 분리 (§4.1.6), (7) Anthropic 1h TTL 옵션 (§4.10), (8) OpenAI effort='minimal' web_search 게이트 (§4.1.2), (9) `redactCredentials()` 자동 적용 (§4.5), (10) Vertex semaphore default-on (§4.4.3), (11) Responses API tool `strict` 모드 변환 probe. **plan 정합**: §3.1 목표 95% → 99%, Phase A에 retry.ts/errors.ts 추출 선행, §8 dispatch error matrix + 가격/cheap-model/thought-signature 회귀 추가, §13 결정 사항 #16~#23 추가, LOC 재추정(코드 ~3,195).
