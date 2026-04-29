# API-Key Providers 통합 플랜 v2

**목표**: PROVIDERS 목록의 API-key 4종(Anthropic / OpenAI / Google Gemini / Vertex AI)을 엔진에 연결. 현재 OAuth 3종(claude-code / codex / copilot)과 가능한 한 동등한 동작.

**Lead**: 본 문서.
**작성일**: 2026-04-30 (v2 — 14개 갭 메우고 최신 정보 반영).

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

### 3.1 Anthropic api_key — 목표 ~95%

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

Responses API에서 호스티드 `web_search` 지원:
- `gpt-5` ✅
- `gpt-5-search-api`, `gpt-5-search-api-2026-10-14` ✅ (검색 특화 변형)
- `gpt-4o`, `gpt-4o-mini` ✅
- `gpt-4o-search-preview`, `gpt-4o-mini-search-preview` ✅ (Chat Completions API용; Responses에서도 가능)
- `gpt-5.4`, `gpt-5.4-mini` ⚠️ Phase 0 probe 검증 필요

→ `providers/models.ts`의 OPENAI_MODELS 카탈로그에 `supportsNativeSearch: bool` 플래그. dispatch 시 모델별 게이팅.

#### 3.2.2 모델 카탈로그 (Apr 2026, openai.com/ko-KR/api/ 검증)

| 모델 | 입력 $/1M | 출력 $/1M | 컨텍스트 | 최대 출력 | 컷오프 | 비고 |
|---|---:|---:|---:|---:|---|---|
| `gpt-5.5` | 5.00 | 30.00 | 1,050,000 | 130,000 | 2025-12-01 | default, search 지원 |
| `gpt-5.4` | 2.50 | 15.00 | 1,050,000 | 130,000 | 2025-08-31 | search ⚠️ probe |
| `gpt-5.4-mini` | 0.75 | 4.50 | 400,000 | 130,000 | 2025-08-31 | search ⚠️ probe |
| `gpt-5` | (기존) | (기존) | (기존) | (기존) | (기존) | search 지원 |
| `gpt-5-mini` | (기존) | (기존) | (기존) | (기존) | (기존) | search 지원 |
| `gpt-4o` | (기존) | (기존) | 128,000 | 16,000 | (기존) | search 지원 |
| `gpt-4o-mini` | (기존) | (기존) | 128,000 | 16,000 | (기존) | search 지원 |

```ts
OPENAI_MODELS = [
  { id: 'gpt-5.5',       label: 'GPT-5.5',       default: true, supportsNativeSearch: true },
  { id: 'gpt-5.4',       label: 'GPT-5.4',       supportsNativeSearch: false /* probe 후 갱신 */ },
  { id: 'gpt-5.4-mini',  label: 'GPT-5.4 mini',  supportsNativeSearch: false /* probe 후 갱신 */ },
  { id: 'gpt-5',         label: 'GPT-5',         supportsNativeSearch: true },
  { id: 'gpt-5-mini',    label: 'GPT-5 mini',    supportsNativeSearch: true },
  { id: 'gpt-4o',        label: 'GPT-4o',        supportsNativeSearch: true },
  { id: 'gpt-4o-mini',   label: 'GPT-4o mini',   supportsNativeSearch: true },
]
```

→ `usage/pricing.ts`에 명시 단가 4종(gpt-5.5, gpt-5.4, gpt-5.4-mini는 검증값) 추가.
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
| Reasoning | **Gemini 3에서 `thinkingLevel`로 마이그레이션** (구 `thinkingBudget` 폐기 예정) | 라운드간 chaining 없음 |
| Fork | 캐시 객체 모델 — prefix-cache 부적합 | **Phase D 비활성** |

**주요 변경 (Apr 2026 검증)**:
- Gemini 3은 `thinkingBudget` → `thinkingLevel` (low/medium/high) 마이그레이션. 어댑터에서 둘 다 지원하되 모델 id 따라 분기.
- Grounding with Google Search 가격: $14 / 1k 검색 (이전 $35/1k에서 인하).

**Reasoning 정책**:
- `effort` 매핑: low → `thinkingLevel: low` (또는 `thinkingBudget: 0~512`), medium → medium, high → high.
- parts에 `thought: true` 마킹된 텍스트는 **transcript 비노출** (raw chain-of-thought UX 저하 방지).

**Safety**:
- `safetySettings`을 `BLOCK_ONLY_HIGH`로 명시 — 미지정 시 보수적 SAFETY 차단으로 코드 어시스턴트 워크로드 막힘.

**모델 카탈로그**:
```ts
GEMINI_MODELS = [
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', default: true, supportsNativeSearch: true, supportsThinking: true },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash', supportsNativeSearch: true, supportsThinking: true },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', supportsNativeSearch: true, supportsThinking: true },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', supportsNativeSearch: true, supportsThinking: true },
]
```

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
`engine/providers.ts`에 `supportsNativeSearch(providerId, model): boolean`:
- claude-code/anthropic: 모든 Claude 4.x ✅
- codex: gpt-5/5.4/5.5 계열 ✅
- openai: 카탈로그 메타 `supportsNativeSearch` 플래그 참조
- gemini/vertex-ai: Gemini 2.0+ ✅, 1.5 → off

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
| `apps/web/lib/server/providers/tool-translation.ts` | ToolSpec → 4 provider 변환 + MCP 검증 | 180 |
| `apps/web/scripts/probe-anthropic-apikey.ts` | Phase 0 probe | 60 |
| `apps/web/scripts/probe-openai-apikey.ts` | Phase 0 probe | 70 |
| `apps/web/scripts/probe-gemini.ts` | Phase 0 probe | 70 |
| `apps/web/scripts/probe-vertex.ts` | Phase 0 probe | 80 |

**신규 합계: 1,650 LOC**

### 5.2 수정 파일

| 파일 | 변경 | LOC |
|---|---|---|
| `providers/claude.ts` | api_key 분기 (헤더, 베타, refresh 우회) | +40 |
| `providers/codex.ts` | 정규화기 호출로 이전, codex 전용 reasoning anchor 콜백 | -100 / +30 (net -70) |
| `providers/caching.ts` | `OpenAIResponsesCachingStrategy`, `GeminiCachingStrategy` (stub) | +90 |
| `providers/models.ts` | OPENAI/GEMINI/VERTEX 분기 + 카탈로그 + `supportsNativeSearch` 메타 | +35 |
| `engine/providers.ts` | dispatch 4개 + `supportsNativeSearch()` + streamCodex 정규화 추출 | +180 |
| `engine/fork.ts:111` | `'claude-code' \| 'anthropic'` 허용 | +5 |
| `engine/session.ts` | `ProviderError` 처리 → UI 메시지 emit | +20 |
| `usage/contextWindow.ts` | 4 블록 추가 | +35 |
| `usage/pricing.ts` | thinking 단가 + 누락 모델 보강 | +15 |
| `agent-frames.ts` / `frames.ts` | `defaultModelFor` 분기 4개 | +24 |
| `tokens.ts` | api_key 헬퍼 + cache invalidation hook | +20 |
| `auth/providers.ts` | gemini/vertex 메타 검증 (anthropic 이미 추가) | +5 |
| `package.json` | `google-auth-library` | +1 |
| `lib/i18n.ts` | error.provider.* 키 5종 × 2언어 | +20 |

**수정 net: +420 LOC**

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

- 코드 신규: **1,650**
- 코드 수정 net: **+420**
- UI: **160**
- 테스트: **750**
- **코드 합계: 약 2,980 LOC**
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

- `probe-anthropic-apikey.ts`: 베타 헤더 매트릭스 (각 베타 단독 + 조합)로 1턴 round-trip. 각각 응답 헤더/에러 dump.
- `probe-openai-apikey.ts`: web_search를 모델별로 시도(`gpt-5`, `gpt-5.5`, `gpt-5.4`, `gpt-4o`). 지원 화이트리스트 갱신.
- `probe-gemini.ts`: googleSearch + thinkingLevel 시도. groundingMetadata 실제 구조 dump.
- `probe-vertex.ts`: 서비스 계정 1개로 `us-central1`/`global` round-trip.

산출물: `dev/active/api-key-providers/probe-results.md` (raw dump + 결정 갱신).

**Gating**: 사용자가 각 provider 실키 1개씩 임시 제공 (또는 본인 계정).

### Phase A — Anthropic api_key (1주, ~280 LOC)
- claude.ts api_key 분기, 베타 분리
- engine dispatch + fork.ts 가드
- contextWindow / pricing / defaultModelFor
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

### Phase D — Gemini api_key (2주, ~900 LOC)
- gemini-shared.ts (wire + parser) + gemini.ts (auth wrapper)
- search 라이프사이클 합성
- thinkingLevel 매핑
- safetySettings BLOCK_ONLY_HIGH default
- 테스트
- 캐싱 미구현 (Phase F)
- env: `OPENHIVE_PROVIDER_GEMINI=1`

### Phase E — Vertex AI (1.5주, ~470 LOC)
- vertex.ts (gemini-shared.ts 재사용)
- auth/vertex.ts + google-auth-library
- region 드롭다운 UI
- service-account JSON 검증
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
13. **Fork 정책**: `claude-code` + `anthropic` 같은 provider끼리만 fork. cross-provider는 `provider_mismatch`로 fresh.
14. **에러 정규화**: `ProviderError` 클래스 + i18n 키 5종.
15. **동시성 cap**: provider id별 default 10, env override.

---

## 13. 변경 로그

- **2026-04-30 — Lead (v1)**: 초기 plan + context 작성. 14개 갭 식별.
- **2026-04-30 — Lead (v2)**: 14개 갭 모두 메움. 최신 정보 반영(Anthropic 베타, OpenAI web_search 화이트리스트, Gemini thinkingLevel 마이그레이션, Vertex cachedContents 엔드포인트). Phase 0(probes) 신설. 횡단 관심사 §4로 통합. Codex 정규화기 인터페이스 §6 상세. LOC 재추정.
- **2026-04-30 — Lead (v2.1)**: GPT-5.5 정정. openai.com 공식 페이지(ko-KR/api/) 직접 확인 — default 모델 확정. 가격(입력 $5/1M, 출력 $30/1M), 컨텍스트(1.05M), 출력(130k), 컷오프(2025-12-01) 반영. `experimental` 플래그 제거. §3.2.2 모델 카탈로그 표 추가.
