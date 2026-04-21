# Spec: 웹페치 native tool

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#13)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

현재 "URL 열어서 본문 가져오기" 기능이 없음. MCP 서버 없이도 Node fetch + readability 로 엔진 내장.

- `tools/base.ts:1-40` Tool interface.
- `session.ts:1669-1698` skillTool, `:1702-1720` mcpTool 패턴.
- `providers/models.ts:50-56` 기존 native fetch + AbortSignal.timeout 패턴.
- `package.json` — `@mozilla/readability` / `jsdom` 없음. 추가 필요.

## 원칙

1. **품질 우선.** 본문 추출은 readability 사용 (raw HTML 투척 X).
2. **보안.** 팀 config `allow_fetch_domains` (기본 `["*"]` 단 localhost/private IP 차단).
3. **토큰 친화.** 20k chars cap (MCP truncation 과 동일 기준). 20k 넘으면 head + 꼬리 힌트.
4. **Lead 기본 노출 X.** 조사 전담 persona (researcher) 에만 allow.

## 변경

### 의존성

```json
"@mozilla/readability": "^0.5.0",
"jsdom": "^24.0.0"
```

### 신규 파일 `lib/server/tools/webfetch.ts`

```ts
export function webfetchTool(): Tool {
  return {
    name: 'web_fetch',
    description: 'Fetch a URL and return article-extracted text. HTML noise is stripped.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
      },
      required: ['url'],
    },
    handler: async (args) => { /* fetch, Readability, cap 20k */ },
  }
}
```

Cap / private-IP guard / timeout 10s.

### 등록

`session.ts:runNode` 의 tool 조립 — persona tools.yaml 에 `web_fetch: true` 있는 경우만 배열에 push.

### tools.yaml 확장

```yaml
web_fetch: true
```

`agents/loader.ts:128-161` parseToolsYaml 에 boolean 필드 추가.

### persona 업데이트

`generic-researcher/tools.yaml` — `web_fetch: true`.

## 테스트

1. 단위: mock fetch → Readability 통과 → 기사 텍스트.
2. 보안: `http://localhost`, `http://10.0.0.1` 거부.
3. cap: 100k 본문 → 반환 길이 ≤ 20k + 꼬리 힌트.
4. 통합: researcher 에 "https://example.com 요약" → 정상 텍스트.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| "요약" 프롬프트 성공률 (MCP 없이) | | |
| Avg fetch latency | — | |

## 롤백

Tool 등록 제거.

## 열린 질문

- [ ] 로봇 배제 (`robots.txt`) 준수 초안 구현 포함? (초안: 스킵. 유저 책임.)
- [ ] 이미지/PDF URL 처리 — 초안 text/html only.
