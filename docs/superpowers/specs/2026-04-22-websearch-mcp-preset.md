# Spec: 웹검색 MCP preset (Tavily / Brave)

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#14)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

`packages/mcp-presets/` 에 slack/notion/gmail/supabase/hubspot 만 있음. 조사 워크플로우 필수인 "웹 검색" preset 없음. Tavily 와 Brave Search 가 MCP 공식/커뮤니티 구현 존재.

- `packages/mcp-presets/slack.yaml` — 포맷 레퍼런스.
- `mcp/presets.ts:98-111` listPresets, `:117-131` materialise.
- `app/api/mcp/presets/route.ts:7-27`.
- `components/settings/sections/McpSection.tsx:54-80`.

## 원칙

1. **두 개 다 추가.** Tavily 는 AI-friendly 요약, Brave 는 개인정보·중립. 유저 선택지.
2. **문서 파일만.** 코드 로직 0 변경.

## 추가 파일

### `packages/mcp-presets/tavily.yaml`

```yaml
id: tavily
name: Tavily Search
icon: "🔎"
brand: tavily
icon_url: /brands/tavily.webp
description: AI-optimised web search with built-in answer summarisation.
command: npx
args: ["-y", "@tavily/mcp-server"]
env_template:
  TAVILY_API_KEY: "{{api_key}}"
inputs:
  - key: api_key
    label: Tavily API Key
    type: secret
    placeholder: tvly-…
    help_text: "https://tavily.com 에서 발급"
    required: true
```

### `packages/mcp-presets/brave.yaml`

```yaml
id: brave
name: Brave Search
icon: "🦁"
brand: brave
icon_url: /brands/brave.webp
description: Independent index, no tracking. Good for general web queries.
command: npx
args: ["-y", "@modelcontextprotocol/server-brave-search"]
env_template:
  BRAVE_API_KEY: "{{api_key}}"
inputs:
  - key: api_key
    label: Brave Search API Key
    type: secret
    placeholder: BSA…
    help_text: "https://brave.com/search/api"
    required: true
```

### 브랜드 아이콘

`public/brands/tavily.webp`, `public/brands/brave.webp` — follow-up (간단 생략 가능, emoji fallback).

## 테스트

1. `/api/mcp/presets` 응답에 신규 2개 포함.
2. UI 에서 설치 → stdio 스폰 + `getTools` 성공.
3. 실제 검색 쿼리 → 결과 return.

## 측정

필요 없음. 기능 추가.

## 롤백

yaml 2개 삭제.

## 열린 질문

- [ ] 공식 Tavily MCP 패키지 이름 확인 필요 — npm registry 체크. (`@tavily/mcp-server` 추정)
- [ ] Brave MCP 는 MCP 공식 레포 (`@modelcontextprotocol/server-brave-search`) 존재 확인됨.
