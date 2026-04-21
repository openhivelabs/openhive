# Spec: 병렬 tool dispatch

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#2)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

한 assistant turn 에서 LLM 이 여러 tool_use 를 동시에 요청해도 엔진이 직렬로 하나씩 처리한다. 이게 유저 체감 속도의 제1원인. Claude Code 는 read/bash/grep 등을 동시에 실행해 체감 3~5배 빠름.

- `apps/web/lib/server/engine/session.ts:554` — `for (const tc of toolCallsForHistory)` 직렬 루프.
- `:580-593` delegate_to / `:595-611` delegate_parallel / `:613-625` ask_user / `:627` 일반 tool.
- `delegate_parallel` 구현(`:926-1075`) + `AsyncQueue`(`:1673-1689`) — **같은 패턴 재사용**.

## 원칙

1. **독립 툴만 병렬.** 상태 mutating 툴(`delegate_to`, `ask_user`, todo tools)은 직렬 유지.
2. **이벤트 인터리빙은 완료순.** history.push 는 원래 tool_call 배열 순서. `AsyncQueue` 로 이벤트 drain.
3. **기본 on.** config flag `parallel_tool_dispatch: false` 로 끌 수 있게.
4. **토큰 목적 아님.** 순수 latency. 품질·스키마 불변.

## 변경

`session.ts` 상단 분류:
```ts
const SERIAL_TOOLS = new Set([
  'delegate_to', 'delegate_parallel', 'ask_user',
  'set_todos', 'complete_todo', 'add_todo',
])
```

루프(`:554`) 재설계: tool_calls 를 연속 런으로 분할 — 독립 런은 `Promise.allSettled` 동시, serial 런은 그대로. worker 이벤트는 `AsyncQueue<{ index, event }>` 로 yield. history.push 는 인덱스 순으로.

Timeout 은 기존 per-tool 값 그대로, 총 walltime = max(worker들).

## 테스트

1. **단위**: 분할 로직 순수 함수 테스트 — [serial, safe, safe, serial] → 3 런.
2. **통합**: 2개 MCP tool 동시 호출 프롬프트 → events.jsonl 에서 `tool_called` 2개 인접, `tool_result` 완료순.
3. **회귀**: delegate + MCP 혼재 turn 에서 history 순서 보존.

## 측정

| 지표 | Before | After | 비고 |
|---|---:|---:|---|
| Wall time (웹페치 3개 동시) | | | 3회 평균 |
| Wall time (single MCP) | | | regression guard |
| LLM 호출 수 | | | 불변 |

## 롤백

flag off 또는 분할 함수가 `[...].map(tc => [tc])` 리턴하도록 단일 줄 변경.

## 열린 질문

- [ ] `read_skill_file` 여러 개 동시 호출 시 `state().readSkillFileSeen` 카운터 race 없는지 — 단위 테스트로 확인 포함.
- [ ] 아키텍처 다이어그램(`03-agent-flow.excalidraw`) 업데이트 — 구현 완료 후 유저 동의 시.
