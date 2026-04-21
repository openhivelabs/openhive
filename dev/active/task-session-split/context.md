# Context — Task/Session Decoupling

## 현재 관련 파일

- `apps/web/lib/server/db.ts` — SQLite migrations.
- `apps/web/lib/server/sessions.ts` — `createSession`, `finalizeSession`, `listSessions`, `sessionUuidForRun`, `backfillSessions`, `repairSessions`.
- `apps/web/lib/server/runs-store.ts` — `runs` 테이블 헬퍼 + 이벤트.
- `apps/web/app/api/runs/start/route.ts` — 런 생성 entrypoint.
- `apps/web/app/api/sessions/route.ts`, `apps/web/app/api/sessions/[uuid]/route.ts` — 세션 조회.
- `apps/web/lib/stores/useTasksStore.ts` — 현재 task.runs[] 관리 + SSE 소비.
- `apps/web/components/tasks/TasksTab.tsx` — Running/Done 컬럼 렌더.
- `apps/web/components/tasks/TaskDetailModal.tsx` — draft/running/needs_input/failed용.
- `apps/web/components/tasks/RunDetailPage.tsx` — done용 full-page.

## 기술 결정

- **영속 PK = session UUID**. 프론트도 URL도 이걸로 통일됨 (`/s/{uuid}`).
- `runs.task_id`는 optional — ad-hoc 실행도 허용 (나중에 채팅 등에서).
- Task persistence: `~/.openhive/tasks/*.json`. 여기서 `runs` 필드 drop.
- 세션 persistence: `~/.openhive/sessions/{uuid}/` + SQLite `runs` row.

## 캐비앗

- `taskStatus(task)` 함수는 현재 draft/running/done/needs_input 전부 판별하는데, 리팩토링 후 task는 runs를 모르므로 draft/scheduled만 남음.
- `composePrompt(task)`는 태스크 스토어에 있지만 세션 시작 시 필요 — 파일 분리해서 공용 유틸로.
- `activeAborts: Map<string, AbortController>` (tasks store) → sessions store로 이관. 키는 세션 UUID.
- SSE 메시지 이벤트에 node_id별 bubble 재구성 로직은 그대로 복붙 가능.

Last Updated: Lead - initial plan
