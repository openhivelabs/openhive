# System DB 제거 — 세션/엔진 상태 FS-only

**작성일:** 2026-04-21
**상태:** 제안 → 승인 대기

## 배경

현재 `~/.openhive/openhive.db` (SQLite) 하나에:
- 세션 메타 + 이벤트 (engine runtime)
- 메시지 (chat tab)
- 사용량 로그 (usage)
- 아티팩트 메타 (artifacts 파일 인덱스)
- 패널 캐시 (panel_cache)
- OAuth 토큰 (oauth_tokens)

이 DB 는 Python 서버 시절에서 포팅돼온 유물. 프로젝트 철학이 **local-first + single-user + "채팅창식"** 으로 명시된 상황에서 시스템 DB 는 오버헤드임.

다만 **팀 도메인 데이터(`data.db`)** 는 예외 — AI 가 스키마 유연하게 조작하는 핵심 장소라 SQLite 유지가 정답. 이번 작업은 시스템 DB 만 제거.

## 원칙

> **시스템 상태는 파일. 유저 도메인 데이터는 SQLite (per-team `data.db`).**

- 시스템 상태 = 엔진이 쓰고 UI 가 읽는 것 (세션/이벤트/usage/artifacts 메타)
- 도메인 데이터 = AI 가 CRUD 하는 유저 비즈니스 레코드

## 목표

- `~/.openhive/openhive.db` 완전 제거
- `better-sqlite3` 의존성은 team data.db 용으로만 남김
- 세션은 `~/.openhive/sessions/{id}/` 폴더 하나로 self-contained
- 기존 DB 데이터는 부팅 시 자동 마이그레이션 후 DB 파일 drop

## 스코프 아웃

- **Team `data.db` 는 건드리지 않음.** SQLite + JSON1 하이브리드 유지.
- 엔진 수정 최소화 (emit 인터페이스만 유지, persist 구현만 교체)

## 변경 요약

### 1. 세션 스토어 (`lib/server/sessions.ts`) 재작성

| 현재 (DB) | 변경 (FS) |
|---|---|
| `sessions` 테이블 row | `sessions/{id}/meta.json` |
| `session_events` 테이블 rows | `sessions/{id}/events.jsonl` (append-only, 라이브) |
| — | `sessions/{id}/transcript.jsonl` (최종화 시 distill) |
| `artifacts` 테이블 rows | `sessions/{id}/artifacts.json` (메타 인덱스) + `artifacts/` 파일들 |

**JSONL append 전략:**
- 엔진이 이벤트 emit → 즉시 `events.jsonl` 에 한 줄 append (flush)
- SSE 리스너는 in-memory 버퍼 + append 감지로 tail (현행 `run-registry` 로직 유지)
- 프로세스 크래시 시 마지막 줄 짤리면 읽기 시 tolerant 파싱 (try/catch per line)

### 2. 메시지 (`lib/server/messages.ts`) → 팀 YAML

`messages` 테이블은 채팅 탭용 팀 공용 대화. 이건 팀별 파일로:
- `~/.openhive/companies/{slug}/teams/{slug}/chat.jsonl` (append)
- 또는 세션 바깥 프리 채팅은 별도 케이스라 일단 이것도 FS.

### 3. Usage (`lib/server/usage.ts`) → 세션별 + 글로벌 캐시

- 세션별: `sessions/{id}/usage.json` (세션 종료 시 집계)
- 팀/에이전트/모델별 집계: 부팅 시 모든 `usage.json` 스캔해서 메모리 인덱스. 수천 세션까진 <1초. 요청 시 메모리에서 서빙.
- 디스크 캐시 (`~/.openhive/cache/usage-summary.json`) optional — 인덱스 재계산 비용 줄이려면.

### 4. Artifacts 메타 (`lib/server/artifacts.ts`) → 세션 안 JSON

- 현재 `artifacts` 테이블: 세션 ID 로 조인해서 `SELECT ... WHERE team_id = ?`
- 대체: `sessions/{id}/artifacts.json` = `[{id, filename, path, mime, size, created_at, skill_name}, ...]`
- 팀 아티팩트 리스트: 팀의 세션들 순회해서 artifacts.json 들 flat merge

### 5. Panel cache → 파일 캐시

- `~/.openhive/cache/panels/{panel_id}.json` = `{data, error, fetched_at, duration_ms}`
- TTL 기반 재fetch 로직은 동일. 단지 저장소만 파일.

### 6. OAuth 토큰 → 암호화 YAML

- 현재 fernet 로 암호화 후 `oauth_tokens` 테이블 row.
- 대체: `~/.openhive/oauth.enc.json` (또는 provider 별 `oauth/{provider_id}.enc.json`). Fernet 암호화 유지.

### 7. `lib/server/db.ts` 제거

- 파일 자체 삭제
- `getDb()` 호출 모두 제거 (위 1~6 모두 교체되면 참조 자연 소멸)

### 8. 엔진 persist 레이어 (`engine/session-registry.ts`)

- 현재 `runsStore.startRun/appendRunEvent/finishRun` 호출 → `sessions.ts` 의 새 함수로 교체
- `sessionsStore.createSession / appendSessionEvent / finalizeSession` 인터페이스는 유지

### 9. Startup 마이그레이션

`instrumentation.ts` 에 한 번:
1. `openhive.db` 존재하면 → 각 테이블 읽어서 파일로 내보냄
   - `sessions` rows → `sessions/{id}/meta.json`
   - `session_events` rows → `sessions/{id}/events.jsonl`
   - `artifacts` rows → `sessions/{id}/artifacts.json`
   - `usage_logs` rows → `sessions/{id}/usage.json` (집계해서)
   - `messages` rows → 팀별 `chat.jsonl`
   - `panel_cache` rows → `cache/panels/{id}.json`
   - `oauth_tokens` rows → `oauth.enc.json`
2. 전부 성공하면 `openhive.db` → `openhive.db.legacy-{timestamp}` 로 rename (삭제 X, 유저가 백업 확인 후 수동 삭제)

### 10. Next instrumentation

- `getDb()` 호출 제거
- `better-sqlite3` import 는 team data DB 모듈에만 남김

## 단계 (순서 엄수)

| 단계 | 내용 | 검증 |
|---|---|---|
| 1 | 세션 스토어 FS-only 재작성 (기존 DB 경로 옆에 나란히) | 엔진 이벤트 양쪽 모두 쓰기, 읽기는 FS 우선 |
| 2 | API 라우트 FS 로 읽기 전환 | `/api/sessions`, `/api/sessions/[id]` 응답 동일 |
| 3 | Artifacts / usage / panel cache / oauth 파일화 | 각 기능 동작 확인 |
| 4 | DB 쓰기 중단 (컴파일 시 모든 `getDb()` 제거) | 타입체크 통과 |
| 5 | 부팅 마이그레이션 추가, 기존 DB → 파일 | 기존 데이터 보존 확인 |
| 6 | `lib/server/db.ts` + 시스템 DB 호출 전부 삭제 | 빌드 통과 |
| 7 | Legacy `openhive.db` 파일 rename, 백업 안내 | 재기동 후 문제 없음 |

## 리스크

1. **라이브 스트리밍 동시성**
   - JSONL append 는 POSIX 상 단일 write 호출이 4KB 이하면 atomic
   - 이벤트 line 은 보통 1KB 미만 → 안전
   - Node `fs.appendFileSync` 사용 (write 후 fsync 옵션 고려)

2. **크로스 세션 집계 성능**
   - 처음 부팅 시 full scan 필요
   - 수천 세션까진 sub-second. 수만 되면 cache 필요 (아직 걱정할 수준 X)

3. **부분 크래시 복구**
   - 세션 중간 크래시 시 events.jsonl 마지막 줄 truncation 가능
   - 읽기 loop 에서 try/catch per line → 깨진 줄 skip + warn

4. **Migration fail-safe**
   - 마이그레이션 성공 전엔 `openhive.db` 삭제 금지
   - rename 만 해서 복구 가능하게

## 검증

- `pnpm dev` 기동 → 기존 47 세션 이 `sessions/{id}/meta.json` 으로 펼쳐지는지 확인
- 새 세션 하나 실행 → events.jsonl 라이브 append + UI 정상 수신
- `sqlite3 ~/.openhive/openhive.db` 해도 시스템 테이블 없는 상태 (legacy 파일로 이동됨)
- `pnpm --filter @openhive/web test` 통과
- `grep -rn 'openhive.db\|getDb()' apps/web/lib/server/` → 0건 (team-data 제외)

## 참고 파일

- 현재 DB 스키마: `apps/web/lib/server/db.ts`
- 세션 FS 초석: `apps/web/lib/server/sessions.ts` (이미 일부 FS 구조 있음)
- 아티팩트: `apps/web/lib/server/artifacts.ts`
- 엔진 persist: `apps/web/lib/server/engine/session-registry.ts`
- 부팅 훅: `apps/web/instrumentation.ts`
