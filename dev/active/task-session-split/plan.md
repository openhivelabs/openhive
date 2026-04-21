# Task ↔ Session Decoupling Plan

**Goal:** Make Session a 1급(first-class) entity, independent of Task. Task becomes a pure template; running a task spawns a Session that stands on its own.

**Why:** 현재 `Task.runs: TaskRun[]` 구조가 "태스크 = 틀, 세션 = 실행 레코드" 모델이랑 엇나감. Done 컬럼은 이미 세션을 평면으로 펼치는데 스토어만 태스크 소유로 묶여있어서 — 매번 task.id + client runId + backendRunId + session uuid 네 개 id를 엮느라 UI가 꼬임.

**Architecture:**
- Backend `runs` 테이블에 `task_id TEXT NULL` 컬럼 추가. `session_uuid`가 이미 영구 식별자로 있으므로 그게 PK 역할.
- 세션 목록/상세는 UUID 기준. Task는 템플릿 프로퍼티만 보유.
- 프론트 `useSessionsStore` 신설 → `runTaskNow / reattachRuns / stopRun / addMessage / updateMessage` 이관. 태스크 스토어는 CRUD만.
- UI: Running/Done/needs_input 컬럼 = 세션 스토어에서 직접. Draft 컬럼 = 태스크 스토어(템플릿).

**비범위(Out of scope for this plan):**
- 태스크 스케줄러가 세션 생성 경로로 전환되는 건 뒤 phase. 이 plan은 스키마/스토어/즉시 실행(`runTaskNow`) 경로까지만.
- 사용자 표시 "Recent sessions" 글로벌 뷰(모든 task 횡단) — 필요하면 후속.

---

## Phase 1 — Backend: session 기반 API

### Task 1.1: `runs` 테이블에 `task_id` 추가

**Files:**
- Modify: `apps/web/lib/server/db.ts` (migrations 배열)

- [ ] Step 1: 기존 마이그레이션 배열 끝에 `ALTER TABLE runs ADD COLUMN task_id TEXT` + 인덱스 `CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id)` 추가.
- [ ] Step 2: dev 서버 재기동 후 `sqlite3 ~/.openhive/openhive.db ".schema runs"` 로 컬럼 반영 확인.

### Task 1.2: `/api/runs/start`에서 task_id 받기

**Files:**
- Modify: `apps/web/app/api/runs/start/route.ts`
- Modify: `apps/web/lib/server/engine/run-registry.ts` (start payload → runs row 저장)
- Modify: `apps/web/lib/api/runs.ts` (`startRun` 시그니처에 `taskId?` 옵션 추가)

- [ ] Step 1: body schema에 optional `task_id` 추가.
- [ ] Step 2: runs INSERT 할 때 `task_id` 컬럼에 값 바인딩.
- [ ] Step 3: `startRun(team, goal, { taskId, locale })` 로 확장.

### Task 1.3: 세션 목록 API

**Files:**
- Modify: `apps/web/app/api/sessions/route.ts` (GET에 `team_id` / `task_id` 쿼리 지원)
- Modify: `apps/web/lib/server/sessions.ts` (`listSessionsFor({ teamId?, taskId? })`)

- [ ] Step 1: `listSessionsFor` 함수 추가 — runs JOIN sessions meta, `team_id`/`task_id`로 필터.
- [ ] Step 2: `/api/sessions?team_id=...&task_id=...` 라우팅 분기 구현.
- [ ] Step 3: 응답에 `{ uuid, run_id, task_id, goal, status, started_at, finished_at, output, error }` 포함.

---

## Phase 2 — Frontend: sessions store 신설

### Task 2.1: 타입 분리

**Files:**
- Modify: `apps/web/lib/types.ts`
- Create: `apps/web/lib/types/session.ts` (optional — 같은 파일 안에 두고 구분만 해도 됨)

- [ ] Step 1: `Session` 타입 신설 — `{ uuid, runId, taskId?, teamId, goal, status: 'running'|'needs_input'|'done'|'failed'|'interrupted', startedAt, endedAt?, error?, messages: Message[], pendingAsk?, viewedAt? }`.
- [ ] Step 2: `Task`에서 `runs` 필드 제거 (2.3 이후 실제 삭제 — 단계적).

### Task 2.2: `useSessionsStore` 작성

**Files:**
- Create: `apps/web/lib/stores/useSessionsStore.ts`

- [ ] Step 1: 스토어 뼈대 — `sessions: Session[]`, `hydrated`, `hydrate(teamId)`, `addSession`, `updateSession`, `removeSession`, `addMessage`, `updateMessage`.
- [ ] Step 2: `startSession(template: { teamId, taskId?, goal, references? })` — `startRun` 호출 + 세션 push + consumeStream 시작.
- [ ] Step 3: `reattachSessions(teamId)` — 서버 세션 목록 fetch → running만 consumeStream 재접속.
- [ ] Step 4: `stopSession(uuid)`, `markViewed(uuid)`.
- [ ] Step 5: 이벤트 소비 로직은 현재 `consumeRunStream`에서 그대로 이관.

### Task 2.3: TasksTab 재배선

**Files:**
- Modify: `apps/web/components/tasks/TasksTab.tsx`
- Modify: `apps/web/components/tasks/TaskDetailModal.tsx`
- Modify: `apps/web/components/tasks/RunDetailPage.tsx`

- [ ] Step 1: Running/Done/needs_input 컬럼 = `useSessionsStore` 의 `sessions.filter(...)`. `doneRuns / runningRuns` 제거.
- [ ] Step 2: 세션 row에 task title 붙일 때는 `tasksStore.find(s.taskId)?.title` join.
- [ ] Step 3: Draft 컬럼은 태스크 스토어 그대로.
- [ ] Step 4: `runTaskNow(task, team)` 호출 → `sessionsStore.startSession({ teamId, taskId: task.id, goal: composePrompt(task), ... })`.
- [ ] Step 5: TaskDetailModal/RunDetailPage가 session을 직접 소비하도록 prop/store 접근 변경.

### Task 2.4: 태스크 스토어 슬림

**Files:**
- Modify: `apps/web/lib/stores/useTasksStore.ts`
- Modify: `apps/web/app/api/tasks/*` (persistence payload에서 `runs` 제거)

- [ ] Step 1: `addRun / updateRun / addRunMessage / updateRunMessage / runTaskNow / reattachRuns / stopRun / markRunViewed` 삭제.
- [ ] Step 2: `Task.runs` 필드 persistence 에서 drop. 역호환: 저장된 태스크 읽을 때 runs 무시.
- [ ] Step 3: `taskStatus()` 삭제 또는 간소화 (draft/scheduled만 분류 — running/done은 세션 쪽).

---

## Phase 3 — 마이그레이션 + 정리

### Task 3.1: 기존 태스크의 runs[] → runs.task_id 백필

**Files:**
- Modify: `apps/web/instrumentation.ts` (boot-time one-shot)
- Create: `apps/web/lib/server/migrations/backfill-task-id.ts`

- [ ] Step 1: 서버 부팅 시 `~/.openhive/tasks/*.json` 읽어서 각 task.runs[].backendRunId에 대응하는 `UPDATE runs SET task_id = ? WHERE id = ?` 실행.
- [ ] Step 2: 성공한 태스크 json 파일에서 runs 필드 삭제 (멱등).
- [ ] Step 3: 로그: `boot: backfilled task_id on N runs`.

### Task 3.2: 문서 업데이트

**Files:**
- Modify: `CLAUDE.md` (Persistence Layout 섹션 — "세션은 태스크와 분리" 명시)

- [ ] Step 1: Task = template, Session = execution record 문구 추가.
- [ ] Step 2: `runs.task_id` optional FK 명시.

---

## 리스크 / 주의

- **SSE 재접속 타이밍**: 지금 `reattachRuns`는 팀 로드시 task.runs 순회. 새 경로에선 팀의 세션 목록을 fetch해야 하므로 첫 hydrate가 끝나기 전엔 재접속 못 함 → 로딩 순서 확인.
- **Task 지우기**: task가 지워져도 관련 세션은 남음 (의도). UI는 `taskId`에 매칭되는 템플릿 없으면 제목을 `session.goal.slice(0, 80)`으로 fallback.
- **기존 task JSON 파일 read-modify-write**: 동시성 이슈 피하려면 boot 시점 1회만.
