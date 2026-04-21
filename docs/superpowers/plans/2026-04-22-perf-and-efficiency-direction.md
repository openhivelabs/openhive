# OpenHive — 성능·효율·품질 개선 로드맵

생성일: 2026-04-22
브랜치: `worktree-improve-performance`
기준 세션: `docs/superpowers/plans/2026-04-21-token-and-reliability-roadmap.md`
참조: `docs/superpowers/specs/2026-04-19-openhive-mvp-design.md`

## 배경

토큰 로드맵(Phase A~H)이 "정확성·토큰"에 집중한 반면, 이 로드맵은 **체감 속도·UX·품질**까지 커버한다. 유저 최종 목표는 "Claude Code / Codex 와 비교했을 때 뒤쳐지지 않는 에이전트 런타임". 체감 속도 저하의 제1원인은 **툴 루프 직렬화** + **MCP 결과 폭주**.

## 원칙

- 한 항목씩 착수한다. 여러 개 섞지 않는다.
- 항목별 스펙(`docs/superpowers/specs/2026-04-22-<slug>.md`)을 먼저 써서 사용자 승인 후 구현.
- 측정 가능한 항목은 **같은 프롬프트 3회 평균**으로 before/after 기록. 양식은 아래 벤치 표.
- i18n · 다이어그램 · destructive 작업 규칙은 루트 CLAUDE.md 준수.

## 진행 상태

| # | Phase | 항목 | 상태 |
|---|---|---|---|
| 1 | 1 | MCP 결과 truncation (cap + 힌트) | 🟡 스펙 작성 중 |
| 2 | 1 | 병렬 tool dispatch (독립 tool_use 동시 실행) | ⬜ |
| 3 | 1 | Lead 내장 Task List (native tool 3종) | ⬜ |
| 4 | 1 | 세션 자동 제목 생성 | ⬜ |
| 5 | 1 | 스킬 Auto-Hint (skill-rules.json + triggers) | ⬜ |
| 6 | 1 | 스킬·툴 Verification 내장 | ⬜ |
| 7 | 1 | 이벤트 쓰기 async 배치 (appendFileSync → queue) | ⬜ |
| 8 | 1 | MCP listTools 글로벌 캐시 | ⬜ |
| 9 | 2 | 전 프로바이더 캐싱 인터페이스 (`CachingStrategy`) | ⬜ |
| 10 | 2 | Python 스킬 cold start 최적화 (워커 풀 폐기) | ⬜ |
| 11 | 3 | 히스토리 슬라이딩 윈도우 (20턴 초과 요약) | ⬜ |
| 12 | 3 | Bundled Persona Gallery (`packages/agents/`) | ⬜ |
| 13 | 3 | 웹페치 native tool | ⬜ |
| 14 | 3 | 웹검색 MCP preset | ⬜ |

## Phase 1 — 속도·품질 즉시 개선

대부분 몇 시간~며칠 단위. ROI 큰 순서.

**#1 MCP 결과 truncation** — `mcp/manager.ts:174` body 생성 직후 길이 cap. 초과분은 버리고 끝에 힌트 블록("[truncated: N chars 잘림. 더 좁은 쿼리로 재시도하거나 {paginate,limit} 파라미터를 사용하세요.]"). 엔진 쪽에는 원본을 `run_events` 에 보존(이미 `tool_result` 이벤트로 감). 체감 1차 원인: Notion/웹 MCP 가 수십 KB 반환하며 Writer input 폭발.

**#2 병렬 tool dispatch** — `session.ts:554` 툴 루프가 `for (tc of toolCallsForHistory)` 로 직렬. 같은 assistant turn 의 독립 tool_use 들은 `Promise.all` 가능. 단, `delegate_to` · `ask_user` 처럼 상태 변경 하는 툴은 직렬 유지(필요 시 옵트인). 이벤트 순서는 툴 시작 순으로 인터리빙 보존(각 sub-generator 결과를 Promise 로 받되 yield 순서는 시작순).

**#3 Lead 내장 Task List** — 현재 엔진엔 없음. Claude Code 의 TodoWrite 유사 기능. native tool 3종: `set_todos(items[])` / `complete_todo(id)` / `add_todo(text)`. 상태는 세션 파일 (`~/.openhive/sessions/<id>/todos.json`). Lead 시스템 프롬프트 상단에 현재 todos 상시 주입. UI 는 사이드 패널 또는 타임라인 탭에 표기.

**#4 세션 자동 제목 생성** — 지금은 session id 만 노출. 첫 user turn 이후 싼 모델(copilot/gpt-5-mini 또는 haiku)로 비동기 `summarizeToTitle(userMessage)` 호출. `sessions.ts` 의 세션 메타에 `title` 필드. UI 사이드바 노출.

**#5 스킬 Auto-Hint** — 유저가 "PDF 만들어줘" 라고만 해도 Lead 가 pdf 스킬 존재를 모를 수 있음. `packages/skills/<name>/SKILL.md` frontmatter 에 `triggers: [regex|keyword]`. 엔진은 user turn 감지 시 rule 매칭 후 시스템 프롬프트 상단에 "힌트: 이 작업은 `pdf` 스킬이 있습니다" 주입.

**#6 Verification 내장** — 스킬 스크립트 끝에 self-check 단계(파일 크기>임계, JSON valid, etc.) 표준 프로토콜. 실패 시 구조화된 에러 JSON. SKILL 작성 가이드에 추가.

**#7 이벤트 쓰기 async 배치** — `sessions.ts:200` 부근 `appendFileSync` 매 이벤트마다 호출 중. 100ms/10건 기준 flush 하는 큐로 전환. SSE fan-out 은 즉시, 디스크는 배치.

**#8 MCP listTools 글로벌 캐시** — `(team.id, allowed_mcp_servers)` 키로 메모. 현재 매 run 시작마다 listTools 호출.

## Phase 2 — 구조적 이득

**#9 전 프로바이더 캐싱 인터페이스** — 현재 Anthropic 만 `cache_control: ephemeral`. `providers/types.ts` 에 `CachingStrategy` 추상화. Claude/Copilot/Codex 각자 구현. Codex 는 Responses API `previous_response_id` 체이닝 또는 summary prefix.

**#10 Python 스킬 cold start 최적화** — 구 "워커 풀" 은 폐기(CLAUDE.md "No long-lived Python process" 규칙 위반 + 복잡도 과다). 대신 subprocess 유지하면서 `-X frozen_modules=on`, lazy import, `.pyc` precompile 로 cold start 자체 축소. 자세히: `specs/2026-04-22-python-cold-start.md`.

## Phase 3 — 개념 정리·기능 확장

**#11 히스토리 슬라이딩 윈도우** — 20턴 초과 시 초기 N턴을 요약 블록(assistant role, 고정 label)으로 치환. `buildMessages` 전에 적용.

**#12 Persona Gallery** — `packages/agents/` 에 code-reviewer / plan-reviewer / researcher / writer / editor AGENT.md + tools.yaml 템플릿 번들.

**#13 웹페치 native tool** — Node `fetch` + `@mozilla/readability`. MCP 필요 없이 엔진 내장.

**#14 웹검색 MCP preset** — Tavily 또는 Brave preset 을 `packages/mcp-presets/` 에 한 줄 추가.

---

## 벤치마크 표 양식

항목별 스펙 문서 하단에 다음 양식으로 before/after 기록. 원본 포맷은 `2026-04-21-token-and-reliability-roadmap.md:8-18` 과 동일.

| 지표 | Before (session_id / 3회 평균) | After (session_id / 3회 평균) | 델타 |
|---|---:|---:|---:|
| Input tokens | | | |
| Output tokens | | | |
| Cache read | | | |
| Wall time (s) | | | |
| LLM 호출 수 | | | |
| 성공 (0/1) | | | |
| 최대 델리게이션 깊이 | | | |

> 같은 프롬프트 3회, Lead 경로 다양성은 "delegation 트리" 로 별도 메모. 단일 run 비교 금지.

## 공통 워크플로우 (각 항목)

1. 영역 전수조사 (`file:line` 메모).
2. `specs/2026-04-22-<slug>.md` 작성 → 사용자 승인.
3. 구현 (한 커밋 = 한 관심사).
4. `pnpm build` + `pnpm --filter @openhive/web test` + 실제 세션 이벤트 로그 확인.
5. 측정 항목이면 벤치 표 갱신.
6. 커밋 메시지 `feat|fix|refactor: …` prefix.
7. 이 문서 진행 상태 표에 `✅ (YYYY-MM-DD, <hash>)` 기록.

## 다이어그램 업데이트 트리거

- #2 병렬 tool dispatch: 엔진 플로우 변경 — 구현 완료 후 유저 동의 시 `03-agent-flow.excalidraw` 갱신.
- #3 Task List native tool: 이벤트 구조·툴 집합 변경 — 마찬가지.
- 그 외는 구현 상세라 다이어그램 건드리지 않음.
