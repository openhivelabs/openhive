# CLAUDE.md

## ⚠️ 작업 속도 규칙 — 최우선

**시간 > 토큰.** 코드 탐색·읽기·작성·검증은 최대한 병렬로 돌려라.

- 독립적인 tool call 은 무조건 한 메시지에 묶어서 동시 실행. 순차 호출은 "앞 결과가 다음 입력에 필요할 때"만.
- 여러 파일 읽기 / grep / find / bash 체크 → 병렬. 한 번에 여러 `Read` + `Bash` + `Edit` 를 한 턴에 쏴라.
- 독립 작업 단위가 2개 이상이면 `Agent` (subagent_type=Explore 등) 를 병렬로 띄워라. 특히 광범위 탐색은 Explore 여러 개 동시.
- 긴 명령 (`pnpm build`, 테스트, 빌드) 은 `run_in_background` 로 띄우고 다른 일 계속 — 완료 알림 기다리며 idle 금지.
- 토큰/비용 아끼려고 순차 실행하지 말 것. 유저는 토큰 소비 각오 상태.

## ⚠️ UI 다국어 규칙 (i18n) — 최우선

**모든 사용자 노출 텍스트는 반드시 `apps/web/lib/i18n.ts` 사전을 거친다.** 하드코딩 라벨·버튼명·안내 문구 금지.

- `const t = useT()` 후 `t('section.key')`. 변수는 `{var}` + `t(key, { var: value })`.
- **새 UI 요소 추가 시 `en` + `ko` 두 사전 모두에 키를 추가한다.** 한쪽만 넣지 말 것.
- `aria-label` / `title` 등 아이콘-only 영역도 번역 적용.
- 예외: 고정 기술값(`localhost:4483`), 제품명(`OpenHive`), 모델 ID 같은 브랜드/식별자는 번역 안 함.
- **수정 체크리스트**: ① 새 문자열이 `t()` 를 거쳤는가 ② `en` + `ko` 둘 다 키 있는가 ③ 한국어가 영어 직역체가 아닌가.

## Project: OpenHive

Local-first, self-hosted, single-user AI 에이전트 오케스트레이션 플랫폼. 유저는 캔버스에서 에이전트 "company" (계층 조직도) 를 디자인하고, 같은 캔버스에서 실행을 본다 (Design/Run 토글). 타깃: 보고서 생성, R&D, 문서 산출물이 중요한 도메인. Web UI 가 레퍼런스 클라이언트지만 서버는 헤드리스로도 동작해야 한다.

## Tech Stack (핵심)

- **Single Node 프로세스, 포트 4483.** **Hono (API) + Vite React SPA (UI)** — 한 프로세스가 `/api/**` 를 Hono 로, 그 외 경로는 `apps/web/dist/` 정적 서빙 + SPA fallback 으로 처리. Next.js 는 2026-04-22 마이그레이션으로 제거 (유휴 RSS ~300–500MB → ~95MB). Python 은 `packages/skills/` 안에서 per-call subprocess 로만 등장.
- **React Router v7** (`createBrowserRouter`) + React Query 로 클라이언트 라우팅/데이터 페칭. Server component 없음, 전부 client.
- `better-sqlite3` — **per-team 도메인 데이터 전용** (`companies/{c}/teams/{t}/data.db`). 시스템 상태는 FS-only.
- `@modelcontextprotocol/sdk`, `cron-parser`+`setInterval` (스케줄러), `fernet` (OAuth 토큰 암호화), `jsonpath-plus` (panel mapper). LLM 호출은 native `fetch` — provider 별 wire protocol 직접 처리.
- 커스텀 async 엔진 in `apps/web/lib/server/engine/`. **LangChain / LangGraph 는 명시적으로 거부 — 재도입 금지.** OAuth-구독 provider 가 ChatModel 추상화에 안 맞고, 델리게이션이 runtime-dynamic 이라 graph-compile-time 모델이 부적합. 자세한 근거는 `docs/superpowers/specs/2026-04-19-openhive-mvp-design.md` §15.
- **Python skill 동시성 상한**: `OPENHIVE_PYTHON_CONCURRENCY` env (기본 `clamp(cpus, 2, 4)`). `acquireSkillSlot` 경유로 피크 RAM 예측 가능. `skill.queued` / `skill.started` 이벤트로 큐 상태 UI 가시화.
- **events.jsonl** 배치 flush: `OPENHIVE_EVENT_FLUSH_INTERVAL_MS` (기본 100), `OPENHIVE_EVENT_FLUSH_THRESHOLD` (기본 10). SIGTERM/SIGINT/beforeExit 훅으로 drain.
- **MCP manager + scheduler 지연 기동**: 첫 사용 시 instantiate. Scheduler tick 은 routine ≥1 일 때만 arm. Eager boot 은 orphan cleanup / transcript backfill / routine 로드로 축소.
- 백엔드는 2026-04-21 Python(FastAPI)→TS 마이그레이션 완료. **`packages/skills/` 외에 Python 재도입 금지.**

## Architectural Rules (절대 준수)

- **델리게이션은 LLM tool call.** Lead 의 LLM 이 런타임에 `delegate_to(...)` 를 호출. Org chart 는 `assignee` enum 의 제약일 뿐, precompiled computation graph 가 아님 — static-graph orchestrator 재도입 금지.
- **엔진 상태는 FS-only.** `~/.openhive/sessions/{id}/` 안에 `meta.json` + append-only `events.jsonl` + `transcript.jsonl` + `artifacts/` + `usage.json`. DB 체크포인터 없음. 재개/재연결 = `events.jsonl` replay. 부팅 시 `running` 으로 남은 세션은 `markOrphanedSessionsInterrupted` 가 `interrupted` 로 정리, transcript 는 `backfillTranscripts` 가 보충.
- **모든 step / tool call 은 typed Event 로 `events.jsonl` 에 append.** Run 캔버스와 Timeline 탭은 동일한 이벤트 스트림을 읽는다 — side channel 만들지 말 것.
- **Frontend 는 LLM 과 직접 통신하지 않는다.** 모든 모델 호출은 백엔드 경유 — OAuth 토큰, API 키, usage tracking 은 서버에만.
- **Long-lived state (MCP manager, 엔진 run registry, scheduler, DB connection, Python skill limiter, event-writer queues) 는 `globalThis` 에.** `Symbol.for('openhive.*')` 키로 감싸 Vite HMR / tsx watch 가 subprocess 누수나 싱글톤 중복을 만들지 않게. 생성은 `getXxx()` lazy 헬퍼 경유 — eager instantiate 금지.
- **Per-node provider + model.** 각 에이전트가 자기 LLM 을 고른다. 공유 ChatModel 추상화 만들지 말 것.
- **UI 캔버스 상태는 YAML 직렬화.** 런타임에 엔진이 YAML 을 읽어 각 노드의 `delegate_to` 후보를 결정.

## Persistence Layout (요약)

- `~/.openhive/sessions/{id}/` — 엔진 런타임 (JSON + JSONL). 시스템 상태.
- `~/.openhive/companies/{c}/{company.yaml, teams/{t}.yaml, teams/{t}/data.db, teams/{t}/chat.jsonl, teams/{t}/dashboard.yaml}` — 디자인 + per-team 유저 도메인 데이터.
- `~/.openhive/{skills/, oauth.enc.json, encryption.key, config.yaml}` — 글로벌.
- **시스템 상태 / 도메인 데이터를 절대 섞지 말 것.** 도메인 데이터는 SQLite + JSON1 하이브리드 (template 정의 컬럼 + `data` JSON 확장 필드). 런타임 DDL 은 AI 권한 게이트로 허용, 모든 스키마 변경은 `schema_migrations` 에 기록.
- 디자인 데이터(`companies/`, `skills/`) 는 Git-versionable, 공유 가능. 런타임 데이터(`sessions/`, `data.db`, `oauth.enc.json`) 는 로컬 사적 — 커밋 금지.

## 인증 / 토폴로지

- 기본은 인증 없음, `localhost` 바인딩. `--host 0.0.0.0` 일 때만 서버가 비번을 강제한다 — **약화 금지.** 멀티유저는 MVP 범위 밖.
- 포트 **4483** (HIVE 키패드). 한 프로세스, 한 포트, UI + API 같이 서빙.
- 배포: install script 가 1순위, Docker 는 옵션. **Docker 필수로 만들지 말 것.** 네이티브 인스톨러는 v2+.

## Common Commands

- `pnpm --filter @openhive/web dev` — Hono (:4484) + Vite (:5173) 동시 기동 (concurrently). 프론트는 Vite dev proxy 로 `/api` → Hono.
- `pnpm --filter @openhive/web dev:hono` / `dev:web` — 각각 단독 기동.
- `pnpm --filter @openhive/web build` — Vite SPA (`apps/web/dist/`) + Hono 서버 (`apps/web/dist-server/`) 순차 빌드.
- `pnpm --filter @openhive/web start` — `NODE_ENV=production node dist-server/server/index.js` — 한 프로세스가 UI + API 를 **포트 4483** 에 서빙.
- `pnpm --filter @openhive/web test` — vitest
- `biome check` — lint / format

## Out of MVP Scope (명시 요청 없으면 만들지 말 것)

In-app Skill Creator · 멀티유저 / RBAC · Docker 기반 skill 샌드박싱 · Skill 마켓플레이스 · 네이티브 데스크톱 / 모바일 클라이언트

## Architecture Diagrams (`docs/architecture/`)

`.excalidraw` 파일은 **한국어로만** 작성 (제목·라벨·노트 전부). 아키텍처(엔진 플로우, 델리게이션, 이벤트 구조, 저장 레이아웃) 변경 시에만 업데이트 — 단순 버그/UI 튜닝은 제외.

업데이트 절차: ① 코드 구현 **먼저 전부 완료** ② 사용자에게 "다이어그램 업데이트할까요?" **명시적 동의** ③ `.excalidraw` 수정 + `export_to_excalidraw` 새 공유 링크 + README 링크 교체 ④ 같이 커밋. 현재 다이어그램: `03-agent-flow.excalidraw` (메인), `01-system-architecture.excalidraw`, `02-delegation-sequence.excalidraw`.

## Working Notes

- 큰 변경 전 `docs/superpowers/specs/` 최신 스펙 확인.
- OAuth provider 코드는 ToS 회색지대 — plugin layer 로 격리, README 에 "use at your own risk" 명시, 구독 우회로 마케팅 금지.
