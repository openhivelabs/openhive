# Spec: Lead 내장 Task List (native tool)

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#3)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

복잡한 작업에서 Lead 가 중간 계획을 잊거나 뒤섞는다. Claude Code TodoWrite 가 이 문제를 해결. OpenHive Lead 에도 내장 todo 툴 3개 + 시스템 프롬프트 상단에 현재 todos 상시 주입.

- `session.ts:57-101` RunState — `todos` Map 추가.
- `session.ts:422-458` runNode tool 조립.
- `session.ts:1336-1364` composeSystemPrompt — todos 섹션 주입.
- `events/schema.ts:10-26` EventKind — `todos_changed` 추가.

## 원칙

1. **Lead(depth=0) 전용 1차.**
2. **run-scoped state.** 종료 시 폐기. 단 이벤트로 UI 복원 가능.
3. **UI 는 follow-up.** 이번 스펙은 백엔드까지.
4. **토큰 목적 아님.** 품질/재현성. 프롬프트 재삽입으로 약간 증가 용인.

## 변경

- `RunState` 에 `todos: Map<sessionId, TodoItem[]>`. `TodoItem = { id, text, done }`.
- `todoTools(sessionId): Tool[]` — 3개 factory.
  - `set_todos(items: string[])` 완전 교체 + id 자동 부여.
  - `add_todo(text: string)` 추가.
  - `complete_todo(id: string)` done=true.
- 각 handler 마다 `todos_changed` 이벤트 (state snapshot payload) emit.
- `composeSystemPrompt` 상단에 `renderTodosSection(todos)`:
  ```
  Current todos (2 pending, 1 done):
    1. [ ] Research MCP servers
    2. [ ] Draft comparison PDF
    3. [x] Gather requirements
  ```
  비어있으면 섹션 자체 생략.
- `runTeamBody` 종료 시 `state().todos.delete(sessionId)`.

## 테스트

1. 단위: 각 handler 호출 → state + 이벤트 payload.
2. 통합: set_todos → 다음 turn 시스템 프롬프트에 섹션.
3. 수동: "3단계 보고서" → events.jsonl 에 `todos_changed` 3+회.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| Input tokens (Lead) | | |
| 완주율 (3회) | | |
| 주관 품질 | | |

품질 우선. 토큰 증가해도 재현성·완주율 상승이면 채택.

## 롤백

Lead tool 조립에서 todoTools 제거 한 줄.

## 열린 질문

- [ ] UI 노출 follow-up 스펙으로 분리 — OK?
- [ ] 엔진 플로우 · 이벤트 구조 변경 → 다이어그램 업데이트 후보. 구현 완료 후 유저 동의 대기.
