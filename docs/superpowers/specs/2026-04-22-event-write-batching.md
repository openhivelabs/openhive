# Spec: 이벤트 쓰기 async 배치

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#7)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

이벤트 기록이 sync fs 호출. 초당 수백 이벤트 내는 스트리밍 토큰 시나리오에서 stall 요인.

- `sessions.ts:200` — `fs.appendFileSync(sessionEventsPath(id), row+'\n', 'utf8')`. 이벤트당 호출.
- `engine/session-registry.ts:163-173` — 엔진 이벤트 loop 에서 sync 호출.
- `:176-177` — SSE fan-out 은 이미 disk 와 독립.

## 원칙

1. **SSE 는 즉시.** 디스크만 배치.
2. **손실 최소.** flush 주기 ≤ 100ms 또는 ≥ 10건 (whichever first).
3. **종료 시 drain.** run 종료 · 프로세스 SIGTERM 에서 잔여 flush.
4. **순서 보존.** seq 필드로 엄격 순서.

## 변경

- 신규 `lib/server/sessions/event-writer.ts`:
  ```ts
  const queues = new Map<sessionId, { buf: string[], timer: NodeJS.Timeout | null }>()
  export function enqueueEvent(sessionId: string, row: StoredEventRow) { ... }
  export async function flushAll(): Promise<void>
  export async function flushSession(sessionId: string): Promise<void>
  ```
  - flush = `fs.promises.appendFile(path, buf.join(''))`.
- `sessions.ts:200` 의 `appendFileSync` 를 `enqueueEvent` 로 교체.
- 세션 종료(`finalizeSession`)시 `flushSession(id)` await.
- `instrumentation.ts` process shutdown hook 에 `flushAll()` await.

## 실패 케이스

- flush 중 crash → 잔여 최대 100ms worth 이벤트 유실. **허용 가능** (SSE 클라이언트는 이미 받았고, 디버거/리플레이 재생 시 seq gap 로 감지).

## 테스트

1. 단위: 20건 연속 enqueue → 100ms 후 파일에 20줄, 순서 seq.
2. 통합: 실제 run — events.jsonl 줄 수 = 이벤트 수. grep 순서 검증.
3. 크래시 시뮬: kill -9 후 잔여 버퍼 ≤ 10건.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| 토큰 스트리밍 중 이벤트 lag (ms) | | |
| 엔진 loop CPU 사용률 | | |

## 롤백

`enqueueEvent` 가 내부에서 즉시 sync flush 하도록 한 줄 변경.

## 열린 질문

- [ ] Node fs.promises 대신 `fs.createWriteStream` 유지 방식 검토 여부 — 초안은 append 로 간단 유지.
