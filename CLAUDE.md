# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: OpenHive

Open-source AI agent orchestration platform. Users design "companies" — hierarchical org charts of AI agents with reporting lines — and assign them work through multiple trigger types (chat, cron, webhook, file watch). Agents coordinate via a custom async engine (LangGraph was explicitly rejected) and produce artifacts (PPTX, DOCX, PDF, etc.) through a Claude-compatible skill system.

Target use cases: report generation, R&D (e.g., semiconductor research), any domain where layered delegation + document output matters.

Design philosophy: local-first, self-hosted, single-user. Headless core + swappable clients (web UI is the primary client, CLI/TUI/mobile possible later). The canvas where users design the org is the same canvas where they watch it execute — Design/Run mode toggle over one view.

## Tech Stack

Single Node process. No Python server. Python only appears as a subprocess
when a skill needs it (PPTX/DOCX/PDF generation, web-fetch, etc.).

Runtime:
- Node.js 24.15.0 LTS
- Next.js 16.2.4 (App Router, Node runtime for `/api/**` route handlers)
- `better-sqlite3` — **per-team domain data only**
  (`companies/{c}/teams/{t}/data.db`). System state is FS-only — there is
  no system SQLite. A boot-time `legacy-db-migration` reads any pre-
  existing `~/.openhive/openhive.db`, migrates its rows to FS stores, and
  renames the file to `openhive.db.legacy-{ts}`.
- `fernet` npm package — Fernet-compatible token encryption. Key file at
  `~/.openhive/encryption.key`.
- `@modelcontextprotocol/sdk` — MCP stdio client (long-lived subprocesses).
- `cron-parser` + `setInterval` — scheduler in `lib/server/scheduler`,
  booted from `apps/web/instrumentation.ts`.
- `jsonpath-plus` — panel mapper row extraction.
- Native `fetch` for LLM calls. Each provider module in
  `lib/server/providers/` speaks its own wire protocol directly.
- Custom async engine in `apps/web/lib/server/engine/` — no LangChain, no
  LangGraph.

Frontend:
- React 19.2.5, @xyflow/react 12.10.2, Tailwind CSS 4.2.2, TypeScript 5.x.

Skill runtime:
- Python or Node scripts under `packages/skills/<name>/` + `~/.openhive/skills/`.
- `lib/server/skills/runner.ts` spawns them per call with `OPENHIVE_OUTPUT_DIR`
  set; generated files are snapshotted and registered as artifacts.
- **No long-lived Python process.**

**Explicitly rejected:** LangChain and LangGraph. See
`docs/superpowers/specs/2026-04-19-openhive-mvp-design.md` §15 for the
custom engine design that replaces them. OAuth-subscription providers
(Claude Code, Codex, Copilot) don't fit LangChain's ChatModel abstraction,
and our delegation semantics are runtime-dynamic rather than graph-compile
-time, so LangGraph is a poor fit. Do not reintroduce either.

**Migration history:** backend ported from Python (FastAPI) to TS between
2026-04-21 and 2026-04-21. See `docs/superpowers/specs/2026-04-21-python-to-
ts-migration.md`. Do not reintroduce Python outside `packages/skills/`.

## Architecture

```
Web UI (Next.js / React)  ← browser
        │ HTTP + SSE
Next.js server (Node, single process, :4483)
 ├─ app/api/**/route.ts              HTTP + SSE route handlers
 ├─ lib/server/engine/               custom async orchestrator. Lead's LLM
 │                                   calls `delegate_to(...)` at run time;
 │                                   org chart constrains the `assignee`
 │                                   enum, routing is a runtime LLM
 │                                   decision, not a precompiled graph.
 ├─ lib/server/tools/                Tool abstraction + OpenAI tool format
 ├─ lib/server/providers/            Claude Code / Codex / Copilot native
 │                                   streaming clients + shape translation
 ├─ lib/server/auth/                 OAuth (PKCE + device-code) + token
 │                                   refresh
 ├─ lib/server/mcp/                  stdio MCP manager (@modelcontextprotocol/sdk)
 ├─ lib/server/skills/               SKILL.md discovery + subprocess runner
 ├─ lib/server/agents/               persona loader + runtime composition
 ├─ lib/server/panels/               mapper / sources / cache / refresher
 ├─ lib/server/scheduler/            cron loop (booted via instrumentation.ts)
 ├─ lib/server/sessions.ts           FS-only session store (meta.json +
 │                                   append-only events.jsonl + transcript
 │                                   + usage + artifacts per session)
 └─ lib/server/engine/session-registry.ts
                                     in-memory session handles on globalThis
                                     + SSE fan-out; replays events.jsonl on
                                     reconnect
        │ subprocess
Skill runtime (Python/Node scripts, spawned per call with OPENHIVE_OUTPUT_DIR)
```

Key architectural rules:
- UI canvas state serializes to YAML. At run time the engine reads the YAML to decide which `delegate_to` targets each node exposes — the org chart is a **constraint on delegation**, not a precompiled computation graph.
- Per-node provider + model — each agent picks its own LLM. No shared ChatModel abstraction; each provider module handles its own wire protocol and quirks directly via `fetch`.
- Multi-agent coordination = LLM tool calling. Delegation is a tool the Lead's LLM invokes at run time. Do not reintroduce a static-graph orchestrator.
- Engine state is FS-only: `meta.json` + append-only `events.jsonl` per session under `~/.openhive/sessions/{id}/`. There is no DB checkpointer. Resume / reconnect = replay `events.jsonl`. On boot, sessions still marked `running` are swept to `interrupted` by `markOrphanedSessionsInterrupted` and transcripts are backfilled by `backfillTranscripts`.
- Every agent step and tool call emits a typed Event to `events.jsonl`. The Run-mode canvas and Timeline tab both read from the same event stream; no side channels.
- Frontend never talks to LLMs directly. All model calls go through the backend so OAuth tokens, keys, and usage tracking stay server-side.

## Persistence Layout

```
~/.openhive/
├── sessions/              Per-session engine state (FS-only, no DB).
│   └── {session-id}/
│       ├── meta.json              session metadata (id, task_id, team_id,
│       │                          goal, status, started_at, finished_at,
│       │                          artifact_count)
│       ├── events.jsonl           append-only engine event stream
│       ├── transcript.jsonl       human-readable transcript (written on
│       │                          finalize; also backfilled on boot)
│       ├── artifacts.json         artifact metadata index
│       ├── artifacts/             generated files (PPTX, DOCX, PDF, etc.)
│       └── usage.json             token usage for this session
├── companies/             Per-company design data + per-team storage.
│   └── {company-slug}/
│       ├── company.yaml                    org chart
│       └── teams/
│           ├── {team-slug}.yaml            team config (sibling YAML file)
│           └── {team-slug}/                team storage directory
│               ├── data.db                 TEAM DATA DB — SQLite + JSON1
│               │                           hybrid (domain tables, edited
│               │                           by AI)
│               ├── chat.jsonl              team chat messages (append-only)
│               └── dashboard.yaml          UI layout (v2 template system)
├── skills/                User-installed skills (SKILL.md + scripts/ + reference/)
├── oauth.enc.json         Fernet-encrypted OAuth token map (all providers,
│                          single file; shard later if it grows)
├── encryption.key         Fernet key for oauth.enc.json
└── config.yaml            Global config (provider keys, server settings)
```

Rules:
- **System state is FS, user domain data is per-team SQLite.** `~/.openhive/sessions/` = engine runtime (JSON + JSONL files). `companies/{c}/teams/{t}/data.db` = user domain data. Do not put domain data in session files, and do not put engine state in team DBs. Backup/portability works per-team (`cp -r teams/{team}`) or per-session (`cp -r sessions/{id}`).
- Design data (companies/, skills/) is static, Git-versionable, user-shareable.
- Runtime data (sessions/, companies/{}/teams/{}/data.db, oauth.enc.json) is local, private, not committed.
- Artifacts live on disk inside the owning session; `artifacts.json` stores only path + metadata references.
- **Team data DB uses SQLite + JSON1 hybrid**: template-defined typed columns + a `data` JSON column for AI-driven extension fields. Runtime DDL (`CREATE TABLE`, `ALTER TABLE`) is allowed for AI, gated by team permission. Every schema change is logged in a `schema_migrations` table so it can be traced/rolled back.

## Repository Layout

```
openhive/
├── apps/
│   └── web/                      Next.js app — frontend AND backend
│       ├── app/
│       │   ├── api/**/route.ts   HTTP + SSE endpoints
│       │   └── <page routes>
│       ├── lib/
│       │   ├── server/           backend modules (engine, providers,
│       │   │                     mcp, panels, skills, scheduler, auth…)
│       │   └── api/              frontend API clients
│       └── instrumentation.ts    runs once at server boot — runs legacy
│                                 DB → FS migration (if openhive.db still
│                                 present), sweeps orphaned running
│                                 sessions to `interrupted`, backfills
│                                 transcripts from events.jsonl, prunes
│                                 legacy artifacts root, migrates task
│                                 YAMLs (runs→sessions), starts scheduler
├── packages/
│   ├── agents/                   bundled personas (AGENT.md + tools.yaml)
│   ├── skills/                   Claude-format skills (SKILL.md + scripts/)
│   ├── frames/                   shareable team frames
│   ├── mcp-presets/              MCP server gallery
│   ├── panel-templates/          dashboard block templates
│   └── templates/                team data DB schema templates
├── docs/
│   └── superpowers/specs/        design specs + migration notes
└── scripts/                      (future CLI entry points)
```

## Common Commands

- `pnpm dev` — start Next.js dev server (:4483) with scheduler + engine
- `pnpm build` — production Next.js build (used by prod `pnpm start`)
- `pnpm start` — production server on :4483
- `pnpm --filter @openhive/web test` — vitest suite
- `biome check` — lint/format

## Authentication

Default: no auth, bound to `localhost` only. When started with `--host 0.0.0.0`, a password is required (enforced by the server — do not weaken this). Multi-user support is explicitly out of MVP scope.

## Runtime Topology & Port

Default port: **`4483`** (HIVE on a phone keypad).

One Next.js process, one port. The Node runtime serves both the UI and
every `/api/**` route handler. Long-lived state (MCP manager, engine run
registry, scheduler, DB connection) lives on `globalThis` so Next dev-mode
HMR doesn't leak subprocesses or duplicate singletons.

Distribution: install script is primary, Docker image is optional. Never
require Docker. Native binaries/installers are v2+.

## Out of MVP Scope

Do not implement these without an explicit request — they are deferred to v2+:
- In-app Skill Creator (maintainer builds skills with Claude's skill-creator externally, commits them to `packages/skills/`)
- Multi-user accounts, RBAC
- Docker-based skill sandboxing (subprocess + permission prompts only in MVP)
- Skill marketplace / sharing platform
- Native desktop or mobile clients

## UI 다국어 규칙 (i18n)

OpenHive 웹 UI의 모든 **사용자 노출 텍스트는 반드시 i18n 사전을 거친다.** 하드코딩된 라벨 · 버튼명 · 안내 문구는 금지.

- 사전 위치: `apps/web/lib/i18n.ts` — `en` / `ko` 두 Record를 유지한다.
- 컴포넌트에서는 `const t = useT()` 후 `t('section.key')` 형태로 호출한다.
- 변수 삽입은 `{var}` 플레이스홀더 + `t(key, { var: value })` 로 처리한다.
- 새 UI 요소를 추가할 때는 **반드시 en + ko 두 로케일 모두에 키를 추가한다.** 한쪽만 넣지 말 것.
- 아이콘-only 영역(탭 비활성, aria-label 등)도 `title` / `aria-label` 에 번역된 텍스트를 넣는다 — 스크린 리더와 툴팁에서 여전히 로케일을 따라야 한다.
- 섹션 헤더의 설명/부제는 생략 가능하더라도, 한 번 넣기로 했다면 두 로케일 모두 번역본을 유지한다.
- 예외: `localhost:4484` 같은 **고정 기술 값**, 제품명(`OpenHive`), 모델 ID 등 브랜드/식별자는 번역하지 않는다.
- **UI 코드 수정 시 체크리스트**:
  1. 추가한 문자열이 `t()` 를 거치는가?
  2. `lib/i18n.ts` 의 `en`, `ko` 두 사전 모두에 키가 있는가?
  3. 번역이 자연스러운가? (영어 직역체가 아닌 한국어 표현)

## Working Notes

- Design docs live in `docs/superpowers/specs/` — always consult the latest design spec before large changes.
- OAuth provider code is a known ToS gray area. Keep it isolated as a plugin layer, document "use at your own risk" in README, never market it as subscription bypass.
- The web UI is the reference client, but the server must stay usable without it (clean HTTP/WS API — other clients come later).

## Architecture Diagrams (`docs/architecture/`)

아키텍처 시각 파일(`.excalidraw`)은 구현과 함께 살아있는 문서다. 규칙:

- **언어: 한국어로만 작성한다.** 제목·라벨·주석·노트 전부 한글. 영어 라벨 금지.
- **업데이트 트리거**: 아키텍처(엔진 플로우, 델리게이션 방식, 이벤트 구조, 저장 레이아웃 등)가 바뀔 때. 단순 버그 수정·UI 튜닝은 제외.
- **업데이트 순서**:
  1. 먼저 코드 구현을 **전부** 완료한다 (부분 구현 상태에서 다이어그램 먼저 그리지 않는다).
  2. 사용자에게 "아키텍처가 X로 바뀌었으니 다이어그램 업데이트할까요?" 라고 **명시적으로 동의를 구한다**.
  3. 동의 받은 뒤에만 `.excalidraw` 파일 수정 + `export_to_excalidraw` 로 새 공유 링크 생성 + README 링크 교체.
  4. `.excalidraw` + README 같이 커밋.
- 현재 다이어그램: `03-agent-flow.excalidraw` (메인 — 에이전트 동작 과정), `01-system-architecture.excalidraw`, `02-delegation-sequence.excalidraw`.
