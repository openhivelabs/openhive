# Run → Session 단일화 (Run 개념 제거)

**작성일:** 2026-04-21
**범위:** 전체 스택 (DB, 엔진, API, 프론트, 디스크 레이아웃)

## 배경

현재 `run`과 `session`이 1:1로 항상 같이 생성되지만 서로 다른 식별자(`run_id` vs `session_uuid`)로 관리됨. 이 중복 때문에:
- URL 파라미터 이름이 실제 값과 어긋남 (`/s/[runId]`에 session UUID가 들어감)
- DB 조인이 불필요 (runs.id ↔ runs.session_uuid 1:1)
- TaskRun / Session 타입이 UI에서 동시에 존재해 헷갈림

Explore 결과: run이 다중 session을 가지거나 그 반대 경로는 **하나도 없음**. 따라서 collapse는 무손실.

## 목표

- `run` 개념 제거. 오직 `session`만 존재.
- `session_id` = 기존의 `session_uuid` (UUID). 모든 FK 이 한 컬럼만 가리킴.
- 디렉토리 `~/.openhive/sessions/{session_id}/` 단일화. 기존 artifacts 레거시 디렉토리 제거 또는 마이그레이션.

## 스코프 아웃

- 엔진의 재시작/resume 로직 개선 — 현재 재시작 없음, 그대로.
- Task 템플릿 구조 변경 없음. `Task.id = taskId` 유지.

## 변경 요약

### 1. DB 스키마

```
runs 테이블 → sessions 테이블로 이름 변경
  - id TEXT PK                 ← 기존 session_uuid (UUID)
  - task_id TEXT               (유지)
  - team_id, goal, status, output, error, started_at, finished_at (유지)
  - 기존 runs.id (ephemeral run_id) 컬럼은 **삭제**
  - 기존 session_uuid 컬럼 → id로 승격

messages.run_id          → session_id
run_events.run_id        → session_id   (테이블명도 session_events로)
usage_logs.run_id        → session_id
artifacts.run_id         → session_id
```

**마이그레이션 전략:** 기존 DB는 아직 개인 로컬뿐. startup 마이그레이션 코드 한 번 넣고 몇 번 돌린 뒤 제거.

```sql
-- pseudo-SQL, 실제로는 CREATE TABLE new + INSERT SELECT + DROP + RENAME
CREATE TABLE sessions_new AS
  SELECT session_uuid AS id, task_id, team_id, goal, status, output, error,
         started_at, finished_at
  FROM runs
  WHERE session_uuid IS NOT NULL;
-- legacy runs without session_uuid → drop (이미 zombie 정리 로직에서 제거됨)

UPDATE messages       SET run_id = (SELECT session_uuid FROM runs WHERE runs.id = messages.run_id);
-- 동일하게 run_events, usage_logs, artifacts
-- 그 다음 컬럼 이름 변경 (ALTER TABLE RENAME COLUMN)
```

### 2. 서버 코드

- `lib/server/runs-store.ts` → `sessions-store.ts` (파일명 + export 전부 sessions-*)
- `lib/server/engine/run.ts` → `engine/session.ts`
- `lib/server/engine/run-registry.ts` → `engine/session-registry.ts`
- `lib/server/sessions.ts` — 기존 session 전용 모듈과 병합
- 함수 `startRun` → `startSession`, `stopRun` → `stopSession`, `recordRunEvent` → `recordSessionEvent` 등 일괄
- 시그니처 변경: `runId: string` → `sessionId: string`

### 3. API 라우트

| 기존 | 신규 |
|---|---|
| `/api/runs/start` | `/api/sessions/start` |
| `/api/runs/[runId]/stream` | `/api/sessions/[sessionId]/stream` |
| `/api/runs/[runId]/stop` | `/api/sessions/[sessionId]/stop` |
| `/api/runs/[runId]/events` | `/api/sessions/[sessionId]/events` |
| `/api/runs/stream` | `/api/sessions/stream` (팀 전체 스트림) |
| `/api/runs/list` | 제거 (기존 `/api/sessions` GET 으로 흡수) |
| `/api/sessions/[uuid]` | `/api/sessions/[sessionId]` (이름만) |

하위 호환 없음 — 프론트와 서버 같은 커밋에서 전환.

### 4. 프론트엔드

- `Task.runs: TaskRun[]` → `Task.sessions: TaskSession[]` (or 그냥 Session)
- `TaskRun` 타입 → `TaskSession` (필드 `backendRunId` → `sessionId`, `id` → `clientSessionId`)
- `useTasksStore`의 `runTaskNow` → `startSessionFromTask`
- `reattachRuns` → `reattachSessions` (기존 sessions-store 쪽과 이름 충돌 해소 — 합병)
- 이미 한 라우트 폴더 `/s/[sessionId]` 는 유지
- `UnifiedSession` 구조는 유지 (이미 session 중심)

### 5. 디스크 레이아웃

현재:
```
~/.openhive/sessions/{uuid}/meta.json, transcript.jsonl, events.jsonl, artifacts/
~/.openhive/artifacts/           ← 레거시, 비어있거나 거의 안 씀
```

변경:
- `~/.openhive/artifacts/` 레거시 디렉토리는 startup 시 존재하면 삭제 or 보관 후 경고. (비어있으면 silent 삭제)
- 새로운 경로 없음. 이미 session 디렉토리 기반으로 쓰고 있음.

## 단계 (순서 엄수)

1. **DB 마이그레이션 코드 작성 + 테스트** (기존 DB 백업 → 마이그레이트 → 정상 로드 확인)
2. **서버 내부 리네임** (runs-store, engine, sessions.ts 합병, artifacts.ts 등 — 한 PR)
3. **API 라우트 이동** (/api/runs/** → /api/sessions/**)
4. **프론트엔드 리네임** (types, stores, API 클라이언트, 컴포넌트 — 한 PR)
5. **레거시 cleanup** (artifacts/ 디렉토리 제거, 주석 정리, 타입 alias 제거)

각 단계는 **자체 빌드/타입체크 통과**해야 함. 도중에 멈출 수 있는 커밋 경계 잡아야 되돌리기 쉬움.

## 리스크 & 완화

- **DB 마이그레이션 중단**: startup 코드 내 트랜잭션으로 감싸기. 실패 시 원복.
- **실행 중인 세션 손실**: 마이그레이션 돌릴 때는 서버 정지 상태에서. 실행 중 run 은 zombie로 처리 후 정리.
- **하위 호환 요청**: 없음. 단일 사용자 로컬 앱이라 하드 스왑 가능.

## 검증

- `pnpm --filter @openhive/web test` 통과
- `pnpm dev` 기동 → 기존 세션 리스트 표시 → 새 세션 실행 → 상세 페이지 → 아티팩트 조회 전 흐름 수동 확인
- `grep -r 'run_id\|runId\|runs\b' apps/web/` 결과: 엔진 내부 레거시 0개 (`/api/runs` 제거 후)

## 참고

- 관련 코드: `apps/web/lib/server/db.ts`, `runs-store.ts`, `sessions.ts`, `engine/run.ts`, `engine/run-registry.ts`, `artifacts.ts`
- 관련 타입: `apps/web/lib/types.ts` (Task, TaskRun, Session)
- 관련 스토어: `apps/web/lib/stores/useTasksStore.ts`, `useSessionsStore.ts`
