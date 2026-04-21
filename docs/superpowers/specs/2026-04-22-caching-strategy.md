# Spec: 전 프로바이더 캐싱 인터페이스

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#9)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

현재 Anthropic 만 `cache_control: ephemeral` 적용 (`claude.ts:197,259,275-281`). Copilot 은 프로토콜 차원의 캐싱 미지원, Codex 는 Responses API 의 `previous_response_id` 체이닝 미구현. 유저가 "토큰 각오" 한 앱이지만, **캐싱은 기능 훼손 없이 토큰/비용 대폭 절감** — 최우선 도입.

- `providers/types.ts:19-28` ChatMessage.
- `providers/claude.ts:197,259,275-281` Anthropic 캐시 마커.
- `providers/codex.ts:162,256-261,273` Responses API, `store: false`, id 미사용.
- `providers/copilot.ts:64` chat/completions, 캐시 필드 없음.

## 원칙

1. **프로바이더별 네이티브 메커니즘.** 공통 cache abstraction 은 얇게.
2. **품질 손상 0.** 캐시 실패 시 fallback = 기존 non-cached 호출.
3. **가시성.** usage_logs 의 cached_tokens 필드 이미 있음 (roadmap "이미 완료" 1번). 각 provider 결과 반영.
4. **기능 훼손 금지.** 캐시 때문에 스트리밍·툴콜·에러 경로 망가뜨리지 말 것.

## 변경

### 공통 인터페이스 (`providers/types.ts`)

```ts
export interface CachingStrategy {
  // message 배열을 프로바이더 포맷으로 변환하기 직전 호출.
  // 반환: 포맷화된 payload. 내부에서 provider-native 캐시 마커/id 주입.
  applyToRequest(req: {
    system: string
    messages: ChatMessage[]
    tools: ToolSpec[]
    previousResponseId?: string | null
  }): { /* provider-specific payload */ }
  // 응답에서 다음 턴 체이닝용 id 추출 (Codex).
  extractResponseId?(resp: unknown): string | null
}
```

### Anthropic/Claude-Code (`claude.ts`)

기존 3-breakpoint (system, last tool, last user message) 를 `AnthropicCachingStrategy` 로 추출. 동작 동등. 회귀 테스트 필수.

### Codex (`codex.ts`)

`CodexCachingStrategy`:
- 이전 turn 의 `response_id` 를 `previous_response_id` 로 체이닝 (`store: true` 로 변경).
- Responses API 가 기존 input 의 prefix 를 서버 측에서 재사용 → 네트워크상 동일 body 를 재전송해도 과금상 캐시 히트.
- `extractResponseId` 로 id 추출해 세션 레벨 Map 에 저장.

### Copilot (`copilot.ts`)

`NoopCachingStrategy`. API 에서 지원 안 함. 단 **system prefix 를 안정화** (같은 노드 내 동일 system prompt 유지) — 추후 OpenAI/GitHub 가 prefix 캐싱 도입 시 자동 혜택.

### 사용 지점

`providers/*.ts` 의 stream entrypoint 에서 전략 객체 1개 생성 → `applyToRequest` 호출.

## 테스트

1. 단위: Anthropic 전략 스냅샷 — 3개 cache_control 마커 정확 위치.
2. 단위: Codex 전략 — previousResponseId 있으면 payload 에 포함, 없으면 생략.
3. 통합: 같은 세션 2턴 후 Codex `usage.prompt_tokens_details.cached_tokens > 0` 관측.
4. 회귀: Anthropic 기존 캐시 히트율 유지.

## 측정

| 지표 | Before | After | 비고 |
|---|---:|---:|---|
| Codex cached_tokens per turn | 0 | | |
| Anthropic cache hit % | 현재치 | | 회귀 없음 확인 |
| Copilot input tokens | 현재치 | | 변동 없음 |
| Wall time per turn | | | |

## 롤백

각 provider 에서 `NoopCachingStrategy` 로 교체 한 줄.

## 열린 질문

- [ ] Codex `store: true` 전환 시 사용자 대화가 OpenAI 에 저장되는 정책 이슈 — ToS 확인 필요.
- [ ] Claude Code(OAuth) 는 Anthropic 과 완전 동일 전략 써도 OK? (현재 코드 공유 중, 가정 유효.)
