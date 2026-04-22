# events.jsonl Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Status note:** 배치 구조는 이미 `apps/web/lib/server/sessions/event-writer.ts` 에 구현되어 있다 (FLUSH_INTERVAL_MS=100, FLUSH_THRESHOLD=10, 체인 플러시). 이 플랜은 **튜닝 + 관측성 + 크래시 리커버리 검증**이 목표.

**Goal:** 배치 임계값을 env 로 조절 가능하게 만들고, 크래시 시 최대 손실량을 상한화하며, 장시간 유휴 세션의 타이머 자원을 회수한다.

**Architecture:** 상수 → env 읽는 함수. flushAll 에 타임아웃. 프로세스 종료 훅(SIGTERM/SIGINT/beforeExit) 보강. 메트릭 카운터 추가.

---

## File Structure

- **Modify** `apps/web/lib/server/sessions/event-writer.ts` — env 기반 설정, 메트릭
- **Modify** `apps/web/lib/server/sessions/event-writer.test.ts` — 새 테스트
- **Create** `apps/web/lib/server/sessions/event-writer-shutdown.ts` — 시그널 훅 (싱글톤 등록)
- **Modify** 서버 부트스트랩 진입점 (보통 `instrumentation.ts` 또는 `apps/web/app/api/health/route.ts` 근처) — shutdown 훅 등록

---

## Task 1: env 기반 임계값

**Files:** `apps/web/lib/server/sessions/event-writer.ts:22-24`

- [ ] **Step 1**: 테스트 추가
```ts
// event-writer.test.ts 하단
it('FLUSH_INTERVAL_MS from env', async () => {
  process.env.OPENHIVE_EVENT_FLUSH_INTERVAL_MS = '250'
  __resetForTests()
  const { flushIntervalMs } = await import('./event-writer')
  expect(flushIntervalMs()).toBe(250)
})
it('FLUSH_THRESHOLD from env', async () => {
  process.env.OPENHIVE_EVENT_FLUSH_THRESHOLD = '20'
  __resetForTests()
  const { flushThreshold } = await import('./event-writer')
  expect(flushThreshold()).toBe(20)
})
```
- [ ] **Step 2**: 구현 — 상수를 함수로
```ts
export function flushIntervalMs(): number {
  const v = Number.parseInt(process.env.OPENHIVE_EVENT_FLUSH_INTERVAL_MS ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 100
}
export function flushThreshold(): number {
  const v = Number.parseInt(process.env.OPENHIVE_EVENT_FLUSH_THRESHOLD ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 10
}
// 내부 사용처: FLUSH_INTERVAL_MS → flushIntervalMs(), FLUSH_THRESHOLD → flushThreshold()
// 기존 상수 export 는 deprecated 표기하고 남겨둬 호환 유지
export const FLUSH_INTERVAL_MS = 100 // @deprecated use flushIntervalMs()
export const FLUSH_THRESHOLD = 10    // @deprecated use flushThreshold()
```
- [ ] **Step 3**: 테스트 PASS
- [ ] **Step 4**: commit `feat(events): configurable flush interval and threshold via env`

## Task 2: 메트릭 카운터

**Files:** `event-writer.ts`

- [ ] **Step 1**: 테스트
```ts
it('tracks metrics', async () => {
  __resetForTests()
  enqueueEvent('s1', JSON.stringify({x:1}))
  enqueueEvent('s1', JSON.stringify({x:2}))
  await flushSession('s1')
  const m = getMetrics()
  expect(m.flushes).toBe(1)
  expect(m.lines).toBe(2)
  expect(m.bytes).toBeGreaterThan(0)
})
```
- [ ] **Step 2**: 구현
```ts
const metrics = { flushes: 0, lines: 0, bytes: 0, errors: 0 }
export function getMetrics() { return { ...metrics } }
// doFlush() 내부 성공 경로 끝에:
metrics.flushes++; metrics.lines += lines.length; metrics.bytes += payload.length
// 실패 경로(catch) 끝에:
metrics.errors++
```
- [ ] **Step 3**: `__resetForTests` 에 metrics 초기화 추가
- [ ] **Step 4**: commit `feat(events): flush metrics counters`

## Task 3: shutdown 훅

**Files:**
- Create: `apps/web/lib/server/sessions/event-writer-shutdown.ts`
- Modify: 부트스트랩 (조사 후 결정 — 아래 Step 0)

- [ ] **Step 0**: 부트스트랩 위치 확인
```bash
grep -rn "markOrphanedSessionsInterrupted\|backfillTranscripts" apps/web --include="*.ts" -l
```
여기 모아둔 부팅 코드 옆에 훅 등록.
- [ ] **Step 1**: 모듈 작성
```ts
// event-writer-shutdown.ts
import { flushAll } from './event-writer'
const KEY = Symbol.for('openhive.eventWriter.shutdownRegistered')
type G = typeof globalThis & { [KEY]?: boolean }

export function registerEventWriterShutdown(): void {
  const g = globalThis as G
  if (g[KEY]) return
  g[KEY] = true
  const drain = async () => {
    try { await Promise.race([flushAll(), new Promise(r => setTimeout(r, 2000))]) }
    catch { /* best effort */ }
  }
  process.on('SIGTERM', () => { void drain().finally(() => process.exit(0)) })
  process.on('SIGINT',  () => { void drain().finally(() => process.exit(0)) })
  process.on('beforeExit', () => { void drain() })
}
```
- [ ] **Step 2**: 부트스트랩에서 `registerEventWriterShutdown()` 1회 호출
- [ ] **Step 3**: 수동 검증 — 세션 실행 중 Ctrl+C → `events.jsonl` 최신 이벤트까지 디스크에 있는지 (cat 으로 확인)
- [ ] **Step 4**: commit `feat(events): flush on SIGTERM/SIGINT`

## Task 4: 유휴 세션 큐 정리

**Files:** `event-writer.ts`

현재 세션별 Queue 가 한 번 만들어지면 `queues` 맵에 남아있음 (영속 맵). 세션 종료 후에도 빈 Queue 객체가 잔존.

- [ ] **Step 1**: 테스트
```ts
it('drops queue after idle drain', async () => {
  __resetForTests()
  enqueueEvent('s1', '{}')
  await flushSession('s1')
  dropIdleQueues()
  // internal: expect no entry for s1
  expect(hasQueueForTest('s1')).toBe(false)
})
```
- [ ] **Step 2**: 구현
```ts
export function dropIdleQueues(): void {
  for (const [id, q] of queues) {
    if (q.buf.length === 0 && !q.timer) queues.delete(id)
  }
}
// test-only export
export function hasQueueForTest(id: string): boolean { return queues.has(id) }
```
세션 종료 경로(engine session.ts 의 finalize/interrupt)에서 `dropIdleQueues()` 호출 또는 해당 세션만 drop.
- [ ] **Step 3**: commit `feat(events): drop idle session queues`

## Task 5: 수용 기준

- [ ] 기존 event-writer 테스트 전체 pass
- [ ] 수동 로드 테스트: 단일 세션 10k 이벤트 append → 손실 없음, RSS 안정
- [ ] Ctrl+C 시 마지막 배치까지 `events.jsonl` 반영
- [ ] 장시간 실행 (30분+) 후 `queues` 메모리 누수 없음
