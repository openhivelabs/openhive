# Context — API-Key Providers

> 플랜 실행 시 참조해야 하는 파일·결정·주의사항. 읽고 시작하세요.

**Last Updated**: Lead - 2026-04-30 - v4: Phase A~E + 폴리시 9건 모두 구현 완료. Phase F/G만 deferred.

---

## 🟢 IMPLEMENTATION COMPLETE

모든 Phase A~E + 9개 폴리시 항목 구현 완료. 6 provider 전부 dispatch + 회귀 480 tests 통과.

### 산출 파일 (참조용)
- 신규 어댑터: `providers/{openai,gemini,vertex}.ts`, `auth/vertex.ts`
- 신규 인프라: `providers/{errors,retry,cheap-model,semaphore,cache-control,openai-response-shared,gemini-shared}.ts`
- 수정 파일: claude.ts (api_key 분기), codex.ts (helper extract), caching.ts (3 strategies + ttl), engine/providers.ts (dispatch + supportsNativeSearch), engine/fork.ts (gate), engine/session.ts (counter split + native_search opt-out), engine/result-cap.ts (cheap-model 폴백), engine/errors.ts (classify 확장), sessions/title.ts (cheap-model 폴백), team.ts (AgentSpec.native_search), models.ts (-preview suffix), contextWindow.ts ([1m] 제거 + anthropic/openai/gemini/vertex 블록), pricing.ts (tiered + cached_input), agent-frames.ts/frames.ts (defaultModelFor), i18n.ts (error.provider.* + nodeEditor.nativeSearch* + settings.providers.vertex*), tokens.ts (clear* 헬퍼)
- UI: ProvidersSection.tsx (Vertex 2-칸), NodeEditor.tsx (web search 토글)
- 문서: docs/providers/{anthropic,openai,gemini,vertex}.md, CHANGELOG.md

### 다음 세션 컨텍스트 회복용 키 사실
- 6 provider dispatch 매트릭스 완성: claude-code (OAuth), anthropic (api_key), codex (OAuth), openai (api_key), copilot (OAuth), gemini (api_key), vertex-ai (api_key/JWT)
- Vertex 모델은 **`global` region에서만** 가용 (Gemini 3.x preview 한정, 2026-04-30 probe 검증). UI default `global`.
- Gemini 모델 ID는 `-preview` suffix 필수 (catalog + contextWindow 모두)
- Anthropic `[1m]` 변형 모두 제거됨 (2026-04-30 retire)
- GPT-5.5/5.4 tiered pricing (>272k 시 입력 2× / 출력 1.5×) `usage/pricing.ts:computeCost` 자동 적용
- Thought Signatures: `gemini-shared.ts`의 per-chainKey `assistantTurns: Map<ordinal, GeminiPart[]>` 캡처/echo
- Phase F (cachedContents): 워크로드 측정 후 결정. 현재 implicit auto-cache 동작.

---

---

## 1. 핵심 파일 레퍼런스

### 1.1 엔진 디스패치 (수정 필수)
- `apps/web/lib/server/engine/providers.ts:50-84` — `stream(providerId, model, messages, tools, opts)` 진입점. 현재 `copilot` / `claude-code` / `codex` 외엔 throw. 신규 4개 분기 추가.
- 동일 파일 line 110-528 — `streamCopilot` / `streamClaude` / `streamCodex` 본체. **streamCodex의 라이프사이클·툴콜·텍스트 정규화 부분(line 283-528)을 `openai-response-shared.ts`로 추출 예정**.

### 1.2 OAuth 어댑터 (참고·재사용)
- `apps/web/lib/server/providers/claude.ts` (349 LOC) — Anthropic Messages API 클라이언트. **Anthropic api_key는 이걸 작은 분기로 확장.**
  - line 23-40: ANTHROPIC_BETA 리스트. api_key용 별도 상수 추가 필요.
  - line 42-47: `ANTHROPIC_HEADERS`. api_key는 `x-api-key` 헤더로 분기.
  - line 104-126: `getAccessToken` — api_key 분기 시 refresh 우회.
  - line 272+: `streamMessages` — providerId 옵션 이미 받음 (`opts.providerId ?? 'claude-code'`).
- `apps/web/lib/server/providers/codex.ts` (555 LOC) — Responses API + chatgpt.com 백엔드.
  - line 21-22: `RESPONSES_URL`. **OpenAI api_key는 `https://api.openai.com/v1/responses` 사용.**
  - line 291-426: `attach_item_ids` 전략 — **chatgpt.com 전용 우회. OpenAI api_key에서는 사용 안 함**.
  - line 489-497: ChatGPT 전용 헤더(`originator`, `chatgpt-account-id`, `User-Agent: codex-cli/...`). OpenAI api_key는 모두 제거.
- `apps/web/lib/server/providers/copilot.ts` — 참고용 (간단한 OpenAI-compatible chat/completions).

### 1.3 캐싱
- `apps/web/lib/server/providers/caching.ts:62-119` — `AnthropicCachingStrategy`. Anthropic api_key는 100% 재사용.
- 동일 파일 `CodexCachingStrategy` (line 154-174) — `attach_item_ids` 전제. **OpenAI api_key용 신규 `OpenAIResponsesCachingStrategy` 추가** (true `previous_response_id` 사용).
- `caching.test.ts` — snapshot 회귀 테스트. 신규 strategy도 동일 패턴으로 추가.

### 1.4 Fork
- `apps/web/lib/server/engine/fork.ts:111` — `child.provider_id !== 'claude-code'` 가드. **`'claude-code' | 'anthropic'` 둘 다 허용으로 완화.**
- 동일 파일 `decideForkOrFresh` 6-gate 로직 — 그 외 변경 불필요.

### 1.5 Pricing / Context Window
- `apps/web/lib/server/usage/pricing.ts:91-156` — PATTERN_PRICING. claude-* / gpt-* / gemini-* 글롭이 이미 거의 전부 커버. **`ModelRates` 인터페이스에 tiered pricing(>272k) + `cached_input` 추가 필수** (v3).
- `apps/web/lib/server/usage/contextWindow.ts:19-49` — provider별 모델 윈도우 표. **anthropic / openai / gemini / vertex-ai 4개 블록 신규 추가**. **`[1m]` Claude 변형은 2026-04-30 retire로 제거** (v3).

### 1.6 Models catalog
- `apps/web/lib/server/providers/models.ts` — 현재 `claude-code` / `anthropic`(이미 추가) / `codex` / `copilot` 분기. **`openai` / `gemini` / `vertex-ai` 분기 추가**.

### 1.7 Auth 등록
- `apps/web/lib/server/auth/providers.ts:16-49` — PROVIDERS 배열. anthropic 이미 추가됨.
- `apps/web/server/api/providers.ts:67-85` — `POST /:providerId/connect/key` 핸들러. **수정 불필요** (이미 일반화됨).

### 1.8 기본 모델 선택
- `apps/web/lib/server/agent-frames.ts:31-40` — `defaultModelFor(providerId)`. 분기 4개 추가.
- `apps/web/lib/server/frames.ts:24-32` — 동일 시그니처 별도 모듈. 동시 수정 필요.

### 1.9 토큰 저장
- `apps/web/lib/server/tokens.ts` — `loadToken(providerId)` 그대로 사용 가능. api_key는 `access_token` 필드에 키 그대로, `refresh_token`/`expires_at` = null.
- **Vertex 예외**: service-account JSON 전체 문자열을 `access_token` 필드에 저장. `auth/vertex.ts`에서 parse 후 `google-auth-library`로 처리.

### 1.10 Probe 스크립트 위치
- `apps/web/scripts/probe-native-events.ts` (Codex)
- `apps/web/scripts/probe-native-via-provider.ts`
- `apps/web/scripts/probe-native-web-search.ts`
- → 같은 디렉토리에 `probe-anthropic-apikey.ts`, `probe-openai-apikey.ts`, `probe-gemini.ts`, `probe-vertex.ts` 추가 예정.

---

## 2. 기술 결정 근거

### 2.1 자체 어댑터 유지 (Vercel AI SDK 미도입)
- 캐싱·reasoning anchor·fork prefix-cache의 픽셀 컨트롤이 필요.
- AI SDK는 SSE 파서·재시도·HTTP를 추상화하지만, 그 추상화 뒤에서 우리가 의존하는 베타·헤더·정확한 위치 기반 마커가 노출 안 됨.
- `engine/providers.ts`의 StreamDelta 정규화 레이어가 이미 SDK 역할(통일된 인터페이스)을 하고 있음.

### 2.2 OpenAI api_key는 `previous_response_id` 사용 (Codex의 `attach_item_ids` 사용 안 함)
- Codex의 우회는 chatgpt.com/backend-api 한정 버그 대응.
- openai.com Responses API는 `previous_response_id + store: true`로 reasoning 복원이 정상 동작 (공식 문서).
- 두 전략을 코드 레벨로 분리 — `caching.ts`에 별도 strategy 클래스.

### 2.3 Gemini 캐싱 v1 미지원
- `cachedContents` API는 별도 객체 생성/관리 + 4096~32768 토큰 최소 prefix 요구.
- 현재 워크로드 분포(평균 prefix 길이, 재사용 빈도)에 대한 데이터 없음 → ROI 불명확.
- 출시 후 측정해서 v2에서 결정. 미지원 = 같은 prefix 반복 호출 시 캐시 히트 0%.

### 2.4 Gemini 검색 라이프사이클 합성
- Gemini는 `googleSearch` tool을 활성화해도 SSE에서 검색 시작/완료 이벤트 자체를 발행 안 함.
- 첫 응답 chunk에서 `groundingMetadata`가 보이는 시점 = 이미 검색 완료된 상태.
- UI parity를 위해 합성 deltas를 강제로 만들어서 칩 표시:
  - 첫 chunk에서 `searching` 발행 (실제로는 이미 끝났지만)
  - `response.completed` 시점에 `completed` + sources

### 2.5 google-auth-library 의존성 추가
- Vertex의 service-account JWT 서명·access_token 교환·1시간 TTL 갱신을 직접 구현하면 ~180 LOC + 보안 책임.
- 라이브러리 사용 시 ~50 LOC + 검증된 갱신 로직.
- 보안에 민감한 영역이라 라이브러리 선호.

### 2.6 Anthropic api_key 베타 헤더 분리
- `claude-code-20250219`, `oauth-2025-04-20`은 OAuth 전용. api_key 요청에 포함 시 4xx 또는 무시.
- `fast-mode-2026-02-01`은 계정별 활성화 (유료 plan). 시도 후 거부 시 자동 제거.
- → api_key용 `ANTHROPIC_BETA_APIKEY` 별도 상수.

### 2.7 검색 = native 우선, function-tool은 backup
- function-tool `web-search` / `web-fetch` 스킬은 스크래핑·captcha 한계 명확.
- provider 호스티드 검색이 품질·안정성 모두 우월.
- 모든 신규 어댑터 default `nativeWebSearch: true`. 모델 미지원 / transient 오류 시에만 함수형 폴백.

---

## 3. 주의사항 (caveats)

### 3.1 Anthropic api_key
- `web_search_20250305` 호스티드 툴은 계정의 web-search quota를 소비 — 고빈도 호출 시 429 가능.
- `interleaved-thinking-2025-05-14` beta는 활성 시 `<thinking>` 블록이 응답 stream에 섞임. 기존 `streamClaude` 정규화에서 이미 처리됨.
- API key 형식: `sk-ant-api03-...` (Anthropic Console). 검증 정규식 추가 가능.

### 3.2 OpenAI api_key
- Responses API는 베타 헤더 `OpenAI-Beta: responses=v1` 또는 unset. Apr 2026 기준 GA.
- `store: true`는 데이터 보존 정책에 영향 — 사용자 노티스 필요.
- `previous_response_id`는 30일 TTL. 그 이상 간격이면 chain 깨짐 — 캐시 만료 처리.
- `web_search` 툴 모델 화이트리스트는 OpenAI 변경 잦음 — 코드에 하드코딩하지 말고 catalog 메타에 `supportsWebSearch: bool` 플래그.

### 3.3 Gemini
- API key 형식: `AIza...` (Google AI Studio).
- `safetySettings`을 명시 안 하면 Gemini가 보수적으로 차단(=`finishReason: SAFETY`). 코드 어시스턴트 워크로드는 `BLOCK_NONE` 또는 `BLOCK_ONLY_HIGH`로 완화 권장.
- `responseSchema` (structured outputs) 지원 — 향후 활용.
- 한국 IP에서 일부 호출이 지역 제한될 수 있음 (보고된 케이스 있음). Vertex로 우회 가능.

### 3.4 Vertex AI
- service-account JSON에 `private_key`(PEM) 포함 — 디스크 저장 시 권한 0600 강제.
- `project_id`는 JSON에서 자동 추출, `location`은 사용자 지정 (default `us-central1`). UI에 region 드롭다운 필요.
- region == `global`이면 host = `aiplatform.googleapis.com` (location prefix 없음).
- Vertex의 `cachedContents` 엔드포인트는 location-scoped — region 잘못 선택 시 캐시 미스.

### 3.5 공통
- 모든 신규 어댑터는 `engine/providers.ts:stream`의 `StreamOpts` 시그니처를 준수해야 함 (`useExactTools`, `overrideSystem`, `temperature`, `sessionId`, `chainKey`, `nativeWebSearch`).
- StreamDelta 시퀀스 마지막은 반드시 `{ kind: 'stop', reason }`. 중간에 throw 시에도 finally에서 stop 발행.
- `cache_read_tokens` / `cache_write_tokens`를 안 셀 수 있는 provider(예: Gemini v1)는 0 또는 undefined로 발행 — UI에서 N/A 표시.

---

## 4. 작업 분배 (Lead 결정)

본 task는 단일 작업자 수행 가정. 병렬 분배 시:

| 역할 | 디렉토리 |
|---|---|
| Backend (제 1 작업자) | `apps/web/lib/server/providers/` (claude.ts 분기, openai.ts, gemini.ts, vertex.ts), `apps/web/lib/server/auth/vertex.ts`, `caching.ts`, `models.ts`, engine/providers.ts dispatch, fork.ts, contextWindow.ts |
| Tester | `apps/web/lib/server/providers/*.test.ts` 신규, `engine/fork.test.ts` 확장, probe 스크립트. **Backend가 머지한 코드만 테스트**, 직접 수정 금지 |
| Code Reviewer | 모든 PR 리뷰. SQL injection·인증 토큰 노출·secret leak 중점 점검. **수정 권한 없음, 메시지로 피드백** |
| Frontend (선택) | UI 그라데이션(미구현 항목 처리), Vertex region 드롭다운, native search 토글 |

### 디렉토리 경계
- 모든 작업자는 자신의 디렉토리 외부 수정 금지.
- 외부 변경 필요 시 Lead/해당 작업자에게 메시지로 요청.

---

## 5. 환경 변수 (신규)

| 변수 | 의미 | 기본값 |
|---|---|---|
| `OPENHIVE_PROVIDER_ANTHROPIC` | Phase A 게이팅 | unset (off) |
| `OPENHIVE_PROVIDER_OPENAI` | Phase C 게이팅 | unset |
| `OPENHIVE_PROVIDER_GEMINI` | Phase D 게이팅 | unset |
| `OPENHIVE_PROVIDER_VERTEX` | Phase E 게이팅 | unset |
| `OPENHIVE_NATIVE_SEARCH_DISABLE` | 모든 native search 강제 off (디버깅) | unset |
| `OPENHIVE_LIVE_TEST` | live API 키로 통합 테스트 | unset |

---

## 6. 추가 주의사항 (v2 보강)

### 6.1 Gemini 3 thinking 마이그레이션
- Gemini 3은 `thinkingBudget` (정수 budget) → `thinkingLevel` (low/medium/high) 마이그레이션. **두 파라미터를 같은 요청에 동시 사용 시 에러** — 모델 id 분기 필수.
- 어댑터: 모델 id가 `gemini-3*`이면 `thinkingLevel`, 그 외(2.5)는 `thinkingBudget`.
- **Gemini 2.5는 카탈로그에서 제거 (2026-06-17 retire)** — Phase D 머지 시점에 ~3주 남음. 카탈로그 노출 시 retire 직후 silent fail.
- `effort` → 매핑: low=`low`/0, medium=`medium`/1024, high=`high`/8192.

### 6.1.1 Gemini 3 Thought Signatures (v3 추가)
- 응답 SSE의 parts에 `thoughtSignature: string` 필드 → reasoning 연속성 anchor (Codex의 `attach_item_ids` + `reasoning.encrypted_content` 등가).
- **캡처**: `gemini-shared.ts` 파서가 `chainKey → signatures[]` Map(globalThis 키)에 누적.
- **Echo**: 다음 라운드 요청 시 같은 part 인덱스에 echo. 누락 시 multi-turn 품질 저하.
- 미반영 시 영향 큼 — Phase D 차단 항목.

### 6.2 Vertex cachedContents 엔드포인트 차이
- Gemini API: `https://generativelanguage.googleapis.com/v1beta/cachedContents`
- Vertex API: `https://{location}-aiplatform.googleapis.com/vertex_ai/v1/projects/{project}/locations/{location}/cachedContents` ← **`/vertex_ai/v1/`** prefix 주의
- Phase F 구현 시 분기 필수.

### 6.3 OpenAI GPT-5.5 (확정)
- openai.com/ko-KR/api/ 공식 페이지 직접 확인 (2026-04-30):
  - 입력: $5.00 / 1M 토큰
  - 출력: $30.00 / 1M 토큰
  - 컨텍스트: 1,050,000
  - 최대 출력: 130,000
  - 지식 컷오프: 2025-12-01
- OPENAI_MODELS의 `default: true`. `experimental` 플래그 미사용.
- `usage/pricing.ts`에 `gpt-5.5` 단가 추가. `usage/contextWindow.ts`의 `'openai'` 블록에 1.05M / 130k.
- (앞서 web 검색 결과로 "미공개"로 잘못 판단했던 부분 정정.)

### 6.4 Anthropic prompt-caching beta
- Apr 2026 시점 prompt caching이 일반 API에 GA됨 (베타 헤더 불필요할 수도).
- 하지만 기존 `prompt-caching-scope-2026-01-05`는 scope 제어용 별개 베타 — 유지.
- **Workspace 격리 (2026-02-05)**: cache key가 organization → workspace 단위. cross-provider fork(claude-code ↔ anthropic)는 cache miss 확정.
- **TTL 변경 (2026-03-06)**: default 1h → 5min. `cache_control: { type: 'ephemeral', ttl: '1h' }` 명시로 1h 복원 가능 (§4.10).
- **`context-1m-2025-08-07` 베타 2026-04-30 retire** — claude.ts ANTHROPIC_BETA에 미포함 확인됨. 모델 카탈로그에서 `[1m]` 변형 제거.
- Phase 0 probe로 베타 미포함 vs 포함 동작 차이 확인.

### 6.5 Codex 정규화기 추출 위험
- streamCodex 본체 ~250 LOC가 8개 상태(toolOrd, sawNativeSearch, nativeQueryByItemId, nativeSources, seenSourceUrls, scratchReasonings, scratchFuncIds, textStreamed)를 동시 관리.
- 추출 시 hooks 인터페이스로 일부 위임 (§6 plan.md). 회귀 차단 — 기존 Codex 픽스처 전부 byte-equivalent 통과 필수.

### 6.6 Live probe 키 관리
- Phase 0 probe 실행 시 사용자가 임시 API 키 제공 필요.
- 결과 dump에 키가 leak되지 않도록 — probe 스크립트는 응답 본문만 dump, 헤더는 `Authorization`/`x-api-key` redact.

### 6.7 멀티모달 deferred
- 현재 OAuth 3종 모두 text-only. Image 입력 지원 안 함 (확인됨).
- 신규 4종도 v1은 text-only. Phase G 별도 트랙.

### 6.8 MCP 툴 Gemini 제약
- Gemini의 `functionDeclarations`는 OpenAPI 3.0 subset.
- `$ref` 미지원 → inline 해석 시도, 실패 시 skip + 경고.
- `oneOf`/`anyOf` 부분 지원.
- `tool-translation.test.ts`에 현재 MCP 카탈로그 통과율 측정 — 임계 5% 이내 skip.

### 6.9 OpenAI Responses tool `strict: true` (v3 추가)
- Responses API는 정확한 schema adherence를 위해 `strict: true` 권장.
- 그러나 strict 모드는 `additionalProperties: false`, 모든 속성 `required` 등 엄격한 제약 — MCP 툴이 위반하는 경우 다수.
- Phase 0 probe(`probe-openai-apikey.ts`)에 strict 모드 변환 통과율 측정. 임계 미달 시 strict-off 폴백 정책 결정.
- `tool-translation.ts`의 `toResponses(tools)`에 strict mode 옵션 노출.

### 6.10 GPT-5.5/5.4 Tiered pricing (v3 추가)
- 입력 토큰 누적 > 272,000 시 **세션 전체에 입력 2× / 출력 1.5× 곱셈**.
- `usage/pricing.ts`의 `ModelRates` 평면 단가 가정과 충돌 — 분기 필수.
- 누적 단위는 "응답당 input tokens"가 아니라 "세션 전체"인지 probe 필요. 임시 가정: per-response.

### 6.11 OpenAI gpt-5 + minimal reasoning + web_search 제약 (v3 추가)
- `reasoning.effort: 'minimal'` 시 web_search 호출 거부 (검증 출처: platform.openai.com docs).
- `supportsNativeSearch(provider, model, opts?: { effort })` 시그니처에 effort 인자 추가.
- 카탈로그 메타로 자동화 어려움 — 함수 본문에 special-case 분기.

### 6.12 cheap-model 폴백 (v3 추가)
- `sessions/title.ts`는 현재 `gpt-5-mini` 하드코딩 → Codex 미연결 시 silent fail.
- `engine/history-window.ts`의 summarise()와 `engine/result-cap.ts`의 LLM 요약도 동일 영향.
- `providers/cheap-model.ts`의 `pickCheapModel(connectedProviders)` 헬퍼로 우선순위 폴백:
  - codex → openai → claude-code → anthropic → gemini → vertex-ai → copilot
  - cheap 모델 매핑: Haiku 4.5 / gpt-5-mini / gemini-3-flash 등 카탈로그 메타 `cheapModel` 플래그
- 미연결 시 null 반환 → 호출부 graceful skip.

### 6.13 Native vs Skill 검색 카운터 분리 (v3 추가)
- 현재 `engine/session.ts`의 `max_web_search_per_turn=5` 캡이 **합산**.
- §4.1.4 폴백("native 실패 → skill")이 합산 캡 때문에 차단됨.
- `nativeSearchCount` / `skillSearchCount` 분리. default native=8, skill=5.
- resetPerTurnCaps()에 두 카운터 모두 reset.

### 6.14 redactCredentials (v3 추가)
- `providers/errors.ts`에 헬퍼. ProviderError 생성 시점 자동 적용.
- 마스킹 패턴: `sk-ant-api03-*`, `sk-*` (OpenAI), `AIza...`, `Bearer ya29.*`, `key=...`, `Authorization`/`x-api-key`/`x-goog-api-key` 헤더 라인.
- probe 스크립트(§6.6)와 동일 함수 재사용.

---

## 7. 변경 로그

- **2026-04-30 — Lead (v1)**: 초기 plan + context 작성. Open Questions 6개 제기. 검색 정책 섹션 추가.
- **2026-04-30 — Lead (v1.1)**: Open Questions 확정. GPT-5.5 포함, Gemini 캐싱 Phase F 분리, Vertex google-auth-library 사용, Gemini 검색 합성, PROVIDERS UI 단계별.
- **2026-04-30 — Lead (v2)**: 플랜 14개 갭 메움. 최신 정보 검증(Anthropic 베타, OpenAI web_search 화이트리스트, Gemini thinkingLevel 마이그레이션, Vertex cachedContents 엔드포인트). Phase 0(probes) 신설. 횡단 관심사 통합(에러 정규화·rate limit·cancel·보안·마이그레이션·UI·문서). LOC 재추정 (코드 ~2,980, 문서 ~290).
- **2026-04-30 — Lead (v2.1)**: GPT-5.5 정정. openai.com 공식 페이지 직접 확인하여 default 모델로 확정. 가격·컨텍스트 정확한 값 반영. `experimental` 플래그 모두 제거.
- **2026-04-30 — Lead (v3)**: 코드베이스 전수조사 검토 결과 반영. §6.1.1(Thought Signatures), §6.4(workspace 격리/TTL/1M retire), §6.9(strict mode), §6.10(tiered pricing), §6.11(effort gate), §6.12(cheap-model), §6.13(검색 카운터), §6.14(redactCredentials) 신규. §1.5에 pricing/contextWindow 갱신 사항 명시.
