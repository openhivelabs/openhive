# Lazy Runtime Init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** MCP manager, scheduler, 기타 상시 리소스를 "처음 쓸 때" 기동하도록 바꿔, 유휴 상태에서 Node RSS 를 추가로 50–150MB 절감한다.

**Architecture:** 각 싱글톤을 `getOrInit()` 패턴으로 감싸고, 부팅 시 eager 초기화 제거. globalThis 키 유지 (HMR 안전). idle shutdown 은 본 플랜 범위 밖 (필요성 확인 후 후속 작업).

**Tech Stack:** TypeScript, globalThis symbol keys, vitest.

---

## File Structure

- **Modify** `apps/web/lib/server/mcp/manager.ts` — `getMcpManager()` 지연화
- **Modify** `apps/web/lib/server/scheduler/scheduler.ts` — `getScheduler()` 지연화
- **Modify** 부트스트랩 진입점 — eager init 코드 제거, markOrphanedSessionsInterrupted/backfillTranscripts 만 유지
- **Modify** manager/scheduler 소비자들 — import → getter 호출로 교체

---

## Task 0: 현재 기동 경로 조사

- [ ] **Step 1**: eager 호출처 찾기
```bash
grep -rn "new McpManager\|initScheduler\|startScheduler\|McpManager()" apps/web --include="*.ts"
grep -rn "getMcpManager\|getScheduler" apps/web --include="*.ts"
```
- [ ] **Step 2**: 부트스트랩 (instrumentation.ts 또는 동등 위치) 에서 eager 호출을 목록화. 각 호출이 **정말 부팅 시 필요한지** (e.g. orphan cleanup) vs **lazy 가능한지** 분류.
- [ ] **Step 3**: 분류표를 이 문서 Task 0 항목 밑에 인라인 기록.

## Task 1: MCP Manager 지연화

**Files:** `apps/web/lib/server/mcp/manager.ts`

- [ ] **Step 1**: 테스트 추가
```ts
it('getMcpManager does not fork subprocesses until called', () => {
  __resetForTests()
  // 기대: globalThis[KEY] 미존재
  expect(hasManagerForTest()).toBe(false)
  getMcpManager()
  expect(hasManagerForTest()).toBe(true)
})
```
- [ ] **Step 2**: 패턴 적용
```ts
const KEY = Symbol.for('openhive.mcp.manager')
type G = typeof globalThis & { [KEY]?: McpManager }

export function getMcpManager(): McpManager {
  const g = globalThis as G
  if (!g[KEY]) g[KEY] = new McpManager(/* existing ctor args */)
  return g[KEY]!
}
export function hasManagerForTest(): boolean { return Boolean((globalThis as G)[KEY]) }
export function __resetForTests(): void { delete (globalThis as G)[KEY] }
```
- [ ] **Step 3**: `new McpManager(...)` 직접 사용처를 전부 `getMcpManager()` 로 교체
- [ ] **Step 4**: 부트스트랩에서 eager 호출 제거 (있다면)
- [ ] **Step 5**: `pnpm --filter @openhive/web test mcp/manager` PASS
- [ ] **Step 6**: commit `refactor(mcp): lazy-init manager on first use`

## Task 2: Scheduler 지연화

**Files:** `apps/web/lib/server/scheduler/scheduler.ts`

- [ ] **Step 1**: 동일 패턴으로 `getScheduler()` 도입
- [ ] **Step 2**: **주의** — scheduler 는 cron 트리거가 외부 이벤트 없이 자체 tick. 이를 "lazy" 로 만들려면 **첫 cron 등록 시** start. 즉 "스케줄된 routine 이 하나도 없는 동안은 setInterval 안 돎".
```ts
export function getScheduler(): Scheduler {
  const g = globalThis as G
  if (!g[KEY]) g[KEY] = new Scheduler({ autoStart: false })
  return g[KEY]!
}
// Scheduler 내부: addRoutine() 시 this.routines.size === 0 이면 start()
// removeRoutine() 시 size === 0 되면 stop()
```
- [ ] **Step 3**: `scheduler.ts` 의 start/stop 경로에 위 조건 반영
- [ ] **Step 4**: 테스트
```ts
it('scheduler setInterval not running with zero routines', () => {
  __resetForTests()
  const s = getScheduler()
  expect(s.isRunningForTest()).toBe(false)
  s.addRoutine({...})
  expect(s.isRunningForTest()).toBe(true)
  s.removeRoutine(id)
  expect(s.isRunningForTest()).toBe(false)
})
```
- [ ] **Step 5**: commit `refactor(scheduler): lazy start when routines present`

## Task 3: 부트스트랩 슬림화

**Files:** 부트스트랩 파일 (instrumentation.ts 등)

- [ ] **Step 1**: 부트 필수 작업만 남김:
  - `markOrphanedSessionsInterrupted()`
  - `backfillTranscripts()`
  - `registerEventWriterShutdown()` (Plan 5 에서 추가)
  - `loadExistingRoutines()` → `getScheduler()` 를 깨우고 routine 들 addRoutine
- [ ] **Step 2**: MCP 관련 eager 호출 제거
- [ ] **Step 3**: 부트 후 `top -pid <pid>` RSS 측정. 목표: 기존보다 50MB+ 감소.
- [ ] **Step 4**: commit `perf(boot): defer MCP/scheduler init until first use`

## Task 4: 수용 기준

- [ ] 콜드 부트 후 유휴 RSS 측정 기록 (before/after)
- [ ] 세션 1개 시작 → MCP 매니저 기동 → 정상 tool call
- [ ] Routine 1개 등록 → scheduler tick 시작, 제거 → stop
- [ ] HMR (pnpm dev 편집-저장-편집) 10회 — subprocess 누수 0

## Out of scope

- Idle auto-shutdown (일정 시간 미사용 후 MCP client 종료) — 필요성 측정 후 후속 플랜.
- MCP client 재사용 간 세션 공유 — 별도 최적화.
