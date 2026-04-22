# Context — Claude Code 패턴 OpenHive 이식

**Last Updated:** Lead — 초기 작성

## 배경

`codeaashu/claude-code` (유출본) + `seilk/claude-code-docs` 분석 → OpenHive 도메인(보고서/R&D 산출물 생성, 회사 메타포 기반 멀티에이전트) 에 핏하는 패턴만 선별.

**기각된 항목 (OpenHive 안 맞음)**:
- memdir cross-session 유저 선호 메모리 — OpenHive 는 파이프라인성. company.yaml + data.db + artifacts 가 영속 메모리 역할 다 함
- CLAUDE.md hierarchy — IDE 패러다임. OpenHive 는 캔버스 디자이너
- Permission modes 6종 — localhost+단일유저라 불필요
- Worktree mode — git 패러다임 무관
- 24-event hook taxonomy — 3개로 충분

**채택된 항목**: P0 (S1-S4) + P1 (A1-A4). B 티어는 후속.

## Claude Code 핵심 패턴 디제스트 (구현 시 참조)

### 서브에이전트 = 재귀 query()
- `tools/AgentTool/runAgent.ts:240-300` — 서브에이전트 = 같은 `query()` 의 새 호출 + isolated context overlay (agentId, file-state cache, MCP merge, permission overlay). 워커풀 X.
- 결과 100KB cap, 부모에는 요약본만. `agent.md` 명시.
- AbortController 분리: async 에이전트는 unlinked signal, sync 는 부모 share.

### Fork 패턴 (cache 보존 병렬)
- `tools/AgentTool/forkSubagent.ts` — 부모 history prefix BYTE-IDENTICAL 유지, 마지막 user message 의 tool_result 들은 모두 동일 placeholder (`'Fork started — processing in background'`), trailing text block 만 자식별로 다름.
- `useExactTools: true` + `override.systemPrompt` 로 prefix 재렌더링 방지 (GrowthBook cold→warm drift 가 캐시 깨먹음 — 코드 주석 명시).
- 재귀 fork 차단: history 에서 `<FORK_BOILERPLATE_TAG>` sentinel 스캔.

### Microcompact (cache 살린 채로 stale tool_result 클리어)
- `services/compact/microCompact.ts` 두 경로:
  - **cache_edits API**: Anthropic 베타 — 서버사이드에서 캐시된 prefix 의 tool_result 삭제. local message 안 건드림. provider 한정.
  - **시간 기반**: 마지막 assistant message 후 N분 경과 → 캐시 콜드 → local 안전 mutate. provider-agnostic.
- 화이트리스트 만 클리어: `FileRead, Bash, Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite`. 트래잭터리 툴 (Task, TodoWrite, AgentTool) 은 절대 안 건드림.
- Token estimation: `roughTokenCountEstimation` ÷ 4 + image flat 2000.

### Auto-compact 3단 fallback
- `effectiveWindow = contextWindow(model) - min(maxOutput, 20_000)`
- `autoCompactThreshold = effectiveWindow - 13_000`
- `blockingLimit = effectiveWindow - 3_000`
- 3 연속 실패 시 circuit breaker (BQ 데이터: 1,279 세션이 50+ 실패, 일 250K API 콜 낭비).
- Stage 1: session memory compact (메시지 단위 prune)
- Stage 2: full compact — 이미지 strip → 라운드 그룹화 → forked subagent 요약 → 메시지 교체 → top-5 referenced files 50K 한도 재로드 → skills 재주입 (25K 총, 5K/skill)

### memdir
- `~/.claude/projects/{slug}/memory/MEMORY.md` (인덱스, 200 lines / 25KB cap) + `{type}_{topic}.md` (4 타입: user/feedback/project/reference).
- 회상 = LLM 이 직접 Grep. 벡터 DB 없음.
- **OpenHive 는 도입 안함** — 대신 Work Ledger (S4) 가 비슷한 역할 도메인 맞춤화.

### Hook 시스템
- 24 이벤트. OpenHive 는 3개만: `SessionStart`, `PreToolUse`, `Stop`.
- Exit code 계약: `0` ok / `2` block + stderr → LLM system message / 그 외 → 유저에게만.
- Sync hook stdout JSON: `{ continue, decision: "approve"|"block", systemMessage, hookSpecificOutput, additionalContext }`.

### Skill lazy loading
- 시스템 프롬프트엔 `name + description + whenToUse` 만 (~30 토큰/스킬). 본문 invoke 시점.
- Frontmatter 키: `paths` (cwd glob, 매칭 시만 노출), `agent` (특정 서브에이전트로 invoke), `context: fork`, `hooks` (스킬 단위), `disable-model-invocation`.

### Tool-class 파티셔닝
- safe (Read/Grep) 10 병렬, unsafe (Edit/Bash) 직렬. `services/tools/toolOrchestration.ts`.

### Streaming + 인터럽트
- `query()` 는 generator. 매 turn: pre-process (snip/microcompact/auto-compact) → API stream → tool_use 들어오는 즉시 dispatch → 결과 yield → 루프.
- `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` — `max_output_tokens` 에러 시 SDK 콜러에 숨기고 3회 재시도.
- `prompt_too_long` 시 reactive compact.

## OpenHive 핵심 파일 위치 (스펙 작성 시 참조)

| 영역 | 파일 | 줄수 |
|---|---|---|
| 메인 엔진 | `apps/web/lib/server/engine/session.ts` | 2161 |
| 세션 레지스트리 | `apps/web/lib/server/engine/session-registry.ts` | 359 |
| 이벤트 writer | `apps/web/lib/server/sessions/event-writer.ts` | 187 |
| 이벤트 schema | `apps/web/lib/server/events/schema.ts` | — |
| 스킬 로더 | `apps/web/lib/server/skills/loader.ts` | 300 |
| 스킬 러너 | `apps/web/lib/server/skills/runner.ts` | — |
| MCP 매니저 | `apps/web/lib/server/mcp/manager.ts` | 316 |
| Provider 디스패치 | `apps/web/lib/server/engine/providers.ts` | — |
| Provider 구현 | `apps/web/lib/server/providers/{claude,copilot,codex}.ts` | — |

### `session.ts` 안 핵심 함수 (감사 결과)
- `runTeam` (328-369) — 엔트리 포인트
- `runNode` (465-613) — 에이전트 드라이버
- `streamTurn` (627-943) — LLM 호출 + 툴 실행
- `runDelegation` (947-1121) — `delegate_to` 실행
- `splitToolRuns` (53-76) — 직렬/병렬 파티션
- `RunState` (108-132) — globalThis singleton
- `historyWindow` / `summariseHistory` (568-569) — **현재 미구현**

## OpenHive 도메인 결정사항 (락인)

1. **Work Ledger 요약 디폴트**: `heuristic` (첫 500자 + 마지막 200자 + artifact 리스트). LLM 옵션은 후속.
2. **Domain 분류**: 1차 = `team.id` (자동), 2차 = `team.yaml` 의 `domain:` 필드 (옵션 override). 자동 LLM 태깅 X.
3. **Memdir 도입 X** — Work Ledger 가 OpenHive 컨텍스트의 메모리 역할.
4. **Microcompact**: 시간 기반 only (provider-agnostic). Claude `cache_edits` API 는 후속.
5. **Hook**: 3개 이벤트만 (`SessionStart`, `PreToolUse`, `Stop`). 24개 도입 X.
6. **결과 cap**: 100KB. 초과시 forked subagent 로 요약 (heuristic 우선, LLM 옵션).

## CLAUDE.md 절대 규칙 (모든 스펙 준수)

- LangChain / LangGraph 재도입 금지
- 엔진 상태 FS-only (sessions/{id}/ 안 events.jsonl + meta.json)
- Long-lived state 는 `globalThis` 에 `Symbol.for('openhive.*')` 로
- 시스템 상태 / 도메인 데이터 분리
- Per-node provider + model
- UI 텍스트는 `apps/web/lib/i18n.ts` 통과, `en` + `ko` 둘 다
- Python 은 `packages/skills/` 안에서만
