# OpenHive — 성능·효율 개선 방향성 + 로드맵

작성일: 2026-04-22
성격: 방향성 문서 (구체 스펙은 각 항목별로 별도 `specs/` 로 쪼갤 것)

## 한 줄 요약

**동시에 돌리고, 한 번 한 건 또 안 하고, 모든 프로바이더에서 캐싱한다.**

---

## 진행 상태

| # | Phase | 항목 | 상태 |
|---|---|---|---|
| 1 | 1 | MCP 결과 truncation (cap + 힌트) | ✅ 2026-04-22 (ea73987) |
| 2 | 1 | 병렬 tool dispatch (독립 tool_use 동시 실행) | ✅ 2026-04-22 (55f3cdd) |
| 3 | 1 | Lead 내장 Task List (native tool 3종) | ✅ 2026-04-22 (27050e4) |
| 4 | 1 | 세션 자동 제목 생성 | ✅ 2026-04-22 (7f7f6e4) |
| 5 | 1 | 스킬 Auto-Hint (skill-rules.json + triggers) | ✅ 2026-04-22 (794b5fe) |
| 6 | 1 | 스킬·툴 Verification 내장 | ✅ 2026-04-22 (86626e8 + a4489c9) |
| 7 | 1 | 이벤트 쓰기 async 배치 (appendFileSync → queue) | ✅ 2026-04-22 (b769929) |
| 8 | 1 | MCP listTools 글로벌 캐시 | ✅ 2026-04-22 (86626e8 + a4489c9) |
| 9 | 2 | 전 프로바이더 캐싱 인터페이스 (`CachingStrategy`) | ✅ 2026-04-22 (171848b) |
| 10 | 2 | Python 스킬 cold start 최적화 (워커 풀 폐기) | ✅ 2026-04-22 (907feca) |
| 11 | 3 | 히스토리 슬라이딩 윈도우 | ✅ 2026-04-22 (ed1c13e) — 기본 비활성 |
| 12 | 3 | Bundled Persona Gallery (`packages/agents/`) | ✅ 2026-04-22 (833b846) |
| 13 | 3 | 웹페치 native tool | ✅ 2026-04-22 (8ac0d49) |
| 14 | 3 | 웹검색 MCP preset | ✅ 2026-04-22 (443d3c7) |

---

## 현황 (2026-04-22 기준 코드 전수조사)

### 속도
- **멀티 delegation이 직렬로 돈다.** Lead 가 한 턴에 `delegate_to(A)` + `delegate_to(B)` 를 뱉어도 B 는 A 의 서브트리가 전부 끝나야 시작 (`apps/web/lib/server/engine/session.ts:648-768`, for-await 루프).
- 진짜 병렬은 `delegate_parallel` 하나뿐인데, **같은 한 명의 부하에게 여러 작업을 쪼갤 때만** 동작 (`session.ts:1089-1119`, `Promise.all`).
- → 이게 "왜 이리 느리지"의 **제1원인**.

### 토큰
- **Claude 만 프롬프트 캐싱 제대로 구현**됨 (`providers/claude.ts:197, 259, 275` — tools / system / 마지막 메시지 3-breakpoint ephemeral cache). 입력 토큰 40-60% 절약 중.
- **Codex, Copilot 은 캐싱 코드 0.** 매 턴 풀 재전송.
- **MCP 툴 결과 길이 무제한** (`mcp/manager.ts:174`). 500KB JSON도 그대로 히스토리에 박혀 매 턴 재전송됨.
- 히스토리 슬라이딩 윈도우 없음. 장기 대화에서 선형 증가.

### 성능 낭비 (자잘)
- **MCP `listTools()` 노드마다 재호출** — 팀·세션 캐시 없고 per-proc 캐시만 있음.
- **Skill subprocess 매번 cold start** — Python 워커 풀 없음. 매번 200-1000ms 인터프리터 부팅.
- **이벤트마다 `fs.appendFileSync` 동기 쓰기** (`sessions.ts:200`) — 턴당 30-50 이벤트 × 5-50ms = 스톨 150-500ms.
- **시스템 프롬프트·툴 배열 노드마다 재계산** — 같은 팀·에이전트면 동일 결과인데 메모화 없음.

### 개념 과설계
- **Agent-format skill 이 툴 3개**로 쪼개짐 (`activate_skill` + `read_skill_file` + `run_skill_script`). 확정 액션(PPTX/PDF 생성 등)엔 과함 → LLM 턴 3배 소모.

---

## 방향성

### 🎯 Direction 1 — 속도: 병렬 delegation
팀원 여러 명한테 동시에 일 시키는 게 기본 케이스인데 현재 직렬. 한 턴에 온 tool_use 중 독립적인 것들(특히 복수 `delegate_to`)을 **`Promise.all` 로 묶어 실행**. 이벤트 순서는 toolCallId 로 묶어서 보존.

- **기대 효과**: 3-way delegation 시 체감 2-3배.
- **주의**: 이벤트 스트림 인터리빙 처리, 동일 에이전트 중복 delegation 가드 유지.

### 🎯 Direction 2 — 토큰: **전 프로바이더 캐싱 통일**
Claude 만 잘 돼있는 상태는 편향. 목표는 "어떤 프로바이더를 쓰든 캐싱 이득을 본다".

- **Claude**: 이미 3-breakpoint ephemeral 캐시 — 유지.
- **Copilot (GitHub Copilot API)**: Anthropic 호환 엔드포인트면 `cache_control` 그대로 적용 가능한지 확인. 불가 시 OpenAI auto-cache 를 최대한 활용하도록 **prefix 안정성 보장** (시스템/툴 순서 고정, nondeterministic 필드 제거).
- **Codex (ChatGPT Responses API)**: 네이티브 prompt caching 미지원. 대안:
  1. 같은 세션이면 `previous_response_id` 체이닝으로 서버 측 대화 상태 재사용 (이미 `codex.ts` 에 session cache 는 있으나 LLM 호출 체이닝엔 미활용 — 확인 필요).
  2. 요약 prefix + 최근 N턴만 전송.
- **공통 계층**: `providers/` 밑에 "캐싱 힌트" 인터페이스를 추상화 (`CachingStrategy`). 각 프로바이더가 자기 방식으로 구현. 엔진은 프로바이더에 무관하게 "이 블록은 재사용 가능" 이라고 선언만.

### 🎯 Direction 3 — 토큰: 컨텍스트 다이어트
- **MCP 결과 truncation**: 2-4KB 초과 시 자르고 `…[truncated, full in event log]` 힌트 (`mcp/manager.ts:174`). 당장 해결해야 할 무계 상태.
- **히스토리 슬라이딩 윈도우**: 20턴 초과 시 초기 턴을 요약 블록으로 치환.
- **시스템 프롬프트 내 파일 트리 상한**: 60개 초과 시 `…and N more`.

### 🎯 Direction 4 — 성능: 재사용 전면화
세 지점에서 "한 번 한 일 다시 안 하기":

1. **Skill 워커 풀**: Python/Node 데몬 1-2개 상주, stdin RPC 로 재사용. cold start 제거.
2. **MCP `listTools` 글로벌 캐시**: `(team.id, allowed_mcp_servers)` 키로 메모화. 서버 재시작 시에만 invalidate.
3. **이벤트 쓰기 async 배치**: `appendFileSync` → 큐 + 100ms or 10건마다 flush. SSE fan-out 은 즉시 유지, 디스크 쓰기만 배치.

### 🎯 Direction 5 — 개념 정리
- **Agent-format skill 축소**: 확정 액션(PPTX/DOCX/PDF/엑셀 등)은 **typed skill 1툴**로 통일. Agent-format 은 "탐색·가이드가 필요한 복합 워크플로우"에만.
- **웹검색 = MCP preset** (Tavily/Brave/SerpAPI 교체 가능하게).
- **웹페치 = Native tool** (고정 동작, subprocess 불필요).
- **(v2 후보) Knowledge 레이어**: 세션 간 기억. 팀별 RAG 테이블 or 에이전트별 `notes.md` append-only. MVP 밖이지만 "회사원 비유"를 살리려면 언젠가 필요.

### 🎯 Direction 6 — 품질: 스킬 Auto-Hint
현재 시스템 프롬프트가 스킬 이름+한줄 설명만 나열 (`session.ts:1443-1456`). LLM이 무시하는 경우 빈번. 해결:

- `skill-rules.json` 같은 매칭 규칙 파일 지원: `keywords`, `intentPatterns`, `pathPatterns`.
- 엔진이 **사용자 프롬프트 / 에이전트 persona 영역** 기반으로 결정론적 매칭 → 해당 스킬을 "우선 검토하라" 힌트로 시스템 프롬프트 상단에 주입.
- **적용 레벨**: 번들 스킬은 `SKILL.md` frontmatter 에 `triggers:` 섹션 추가, 사용자 스킬은 optional.

### 🎯 Direction 7 — 품질: Lead 내장 Task List
- 새 native tool: `set_todos(items)`, `complete_todo(id)`, `add_todo(content)`.
- Lead 시스템 프롬프트에 규칙: "복수 단계 작업이면 먼저 set_todos 로 선언, delegation 끝날 때마다 업데이트".
- **핵심**: todos 는 히스토리가 압축돼도 **시스템 프롬프트 상단에 상시 유지** → 컨텍스트 긴 세션에서도 "잃어버림" 불가.
- UI 에도 노출 → 사용자가 진행 상황 실시간 확인.

### 🎯 Direction 8 — 품질: 스킬·툴 자체 Verification
**각 스킬·툴이 실행 완료 직후 자체 sanity check 를 포함**:

- PDF/PPTX/DOCX 스킬 → 리턴 시 파일 크기·페이지 수·열림 여부 체크, 리턴 payload 에 `verification: { ok, details }` 포함.
- 웹페치 → 200 응답·non-empty 확인.
- 실패 시 단순 실패가 아니라 **"무엇이 왜 실패" 를 LLM 에게 피드백** → 자율 재시도.
- SKILL.md 작성 가이드에 "verification 단계 포함" 을 **의무 체크리스트** 로.

### 🎯 Direction 9 — 경량: Bundled Persona Gallery 확충
OpenHive persona 시스템에 번들 템플릿 추가:

- `code-reviewer`, `plan-reviewer`, `researcher`, `writer`, `editor` 등 기본 persona.
- 사용자가 첫 팀 짤 때 "템플릿에서 끌어오기" UX.
- `packages/agents/` 확장 작업. 코드 변경 거의 없음, 주로 콘텐츠.

### 🎯 Direction 10 — UX: 세션 자동 제목 생성
- 세션 스토어에 `title: string | null` 필드 추가.
- **첫 유저 메시지 or N회 교환 후** 비동기로 **싼 모델**(예: Haiku / Mini) 에 한 번 호출 → 5-8단어 제목 생성.
- 생성은 **async fire-and-forget**, 세션 진행 블록 금지. 실패 시 fallback 으로 draft 이름.
- 사용자 수동 rename 가능.
- Sidebar 의 세션 리스트가 이 title 을 1차로 표시.

---

## 개념 재검토: Agent-format vs Typed Skill

- **Progressive disclosure** (가벼운 main SKILL + on-demand 리소스 로드) 가 토큰 40-60% 절약시킴.
- Agent-format 의 `activate → read → run` 3툴 분리는 **탐색·가이드 복잡 워크플로우** 에선 올바름.
- 단 **확정 액션** (PDF/PPTX/DOCX 생성 등) 엔 typed 1툴이 여전히 더 나음 (3턴 낭비).

**수정 규칙**:
- Typed skill: 파라미터가 명확하고 1-shot 실행 가능한 확정 액션.
- Agent-format skill: 다단계·조건 분기·여러 파일 참조가 필요한 복합 워크플로우.
- SKILL 작성 가이드 문서에 판정 플로우차트 명기.

---

## 측정 방법

각 phase 전후로 **동일 프롬프트 3회 평균**을 기록 (LLM 비결정성 때문에 단발 비교 금지). 포맷은 `2026-04-21-token-and-reliability-roadmap.md` 표 참고:

| 지표 | Before (session_id / 3회 평균) | After (session_id / 3회 평균) | 델타 |
|---|---:|---:|---:|
| Input tokens | | | |
| Output tokens | | | |
| Cache read | | | |
| Wall time (s) | | | |
| LLM 호출 수 | | | |
| 성공 (0/1) | | | |
| 최대 델리게이션 깊이 | | | |

---

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
