# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: OpenHive

Open-source AI agent orchestration platform. Users design "companies" — hierarchical org charts of AI agents with reporting lines — and assign them work through multiple trigger types (chat, cron, webhook, file watch). Agents coordinate via LangGraph workflows and produce artifacts (PPTX, DOCX, PDF, etc.) through a Claude-compatible skill system.

Target use cases: report generation, R&D (e.g., semiconductor research), any domain where layered delegation + document output matters.

Design philosophy: local-first, self-hosted, single-user. Headless core + swappable clients (web UI is the primary client, CLI/TUI/mobile possible later). The canvas where users design the org is the same canvas where they watch it execute — Design/Run mode toggle over one view.

## Tech Stack (pinned to latest stable as of 2026-04-19)

> ⚠️ **MIGRATION IN PROGRESS (2026-04-21 →).** All non-skill backend code is
> moving from Python (FastAPI) to TypeScript (Next.js route handlers). See
> `docs/superpowers/specs/2026-04-21-python-to-ts-migration.md`. During the
> migration:
>
> - **No new Python code outside `packages/skills/`.** Every new endpoint,
>   persistence module, engine feature, provider adapter, or MCP integration
>   goes in `apps/web/app/api/**` or `apps/web/lib/server/**`.
> - Python stays for existing endpoints until their phase migrates; after
>   Phase 7 only `packages/skills/` + a thin `packages/skill-runner/` remain.
> - Both runtimes read/write the same `~/.openhive/openhive.db` and
>   `~/.openhive/encryption.key` during transition — schemas and key format
>   MUST NOT drift.

Backend (post-migration target):
- Node.js 24.15.0 LTS
- Next.js 16.2.4 (App Router, Node runtime for `/api/**` route handlers)
- `better-sqlite3` (runtime state, checkpoints, messages, events, usage, OAuth tokens)
- `fernet` npm package (Fernet-compatible token encryption — key file shared with legacy Python)
- Native `fetch` / `undici` for LLM calls (replaces httpx)
- Custom async engine in `apps/web/lib/server/engine/` — no LangChain, no LangGraph

Backend (legacy, being removed):
- Python 3.14.3 + FastAPI 0.136.0 at `apps/server/` — do not extend

Frontend:
- Node.js 24.15.0 LTS
- Next.js 16.2.4 (App Router)
- React 19.2.5
- @xyflow/react 12.10.2 (org chart canvas)
- Tailwind CSS 4.2.2
- TypeScript latest 5.x

Skill runtime:
- Python subprocesses for file generation (python-pptx, python-docx, reportlab, pypdf, weasyprint, pandoc)
- Node subprocesses allowed for skills that need them

Security-sensitive dependencies (Next.js, FastAPI/Starlette, httpx, cryptography, OAuth libs) track `latest` via Renovate/Dependabot.

**Explicitly rejected:** LangChain and LangGraph. See `docs/superpowers/specs/2026-04-19-openhive-mvp-design.md` §15 for the custom engine design that replaces them. OAuth-subscription providers (Claude Code, Codex, Copilot) don't fit LangChain's ChatModel abstraction, and our delegation semantics are runtime-dynamic rather than graph-compile-time, so LangGraph is a poor fit. Do not reintroduce either.

## Architecture

```
Web UI (Next.js/React)  ← browser
        │ HTTP + SSE/WebSocket
Server (Python/FastAPI)
 ├─ Engine (custom async orchestrator) — Lead's LLM calls `delegate_to(...)`
 │  tool at run time to invoke subordinates. Org chart constrains the
 │  `assignee` enum; actual routing is a runtime LLM decision, not a
 │  precompiled graph.
 ├─ Tool layer
 │   ├─ Delegation tools (built-in, injected per node from edges)
 │   ├─ Skill tools (subprocess, permission-gated)
 │   ├─ MCP tools (remote MCP servers, Phase 2)
 │   └─ Per-provider format translation (OpenAI vs Anthropic tool shapes)
 ├─ Provider layer (direct httpx per provider)
 │   ├─ OAuth providers (Claude Code, Codex, Copilot, Gemini CLI) — token dance lives in each module
 │   ├─ API key providers (Anthropic, OpenAI, Gemini, etc.)
 │   └─ Local providers (Ollama, LM Studio)
 ├─ Skill registry — loads Claude-format skills from ~/.openhive/skills/
 ├─ Trigger manager — chat, cron, webhook, file watch, manual
 └─ Event bus — typed events → run_events SQLite + SSE/WebSocket fan-out
        │ subprocess
Skill runtime (Python/Node scripts, sandboxed via subprocess + permission prompts)
```

Key architectural rules:
- UI canvas state serializes to YAML. At run time the engine reads the YAML to decide which `delegate_to` targets each node exposes — the org chart is a **constraint on delegation**, not a precompiled computation graph.
- Per-node provider + model — each agent picks its own LLM. No shared ChatModel abstraction; each provider module handles its own wire protocol and quirks directly via httpx.
- Multi-agent coordination = LLM tool calling. Delegation is a tool the Lead's LLM invokes at run time. Do not reintroduce a static-graph orchestrator.
- Engine checkpoints are plain JSON-serialized `RunState` rows in SQLite — resume = load latest + re-enter event loop. Never bypass the checkpointer.
- Every agent step and tool call emits a typed Event. The Run-mode canvas and Timeline tab both read from the same event stream; no side channels.
- Frontend never talks to LLMs directly. All model calls go through the backend so OAuth tokens, keys, and usage tracking stay server-side.

## Persistence Layout

```
~/.openhive/
├── openhive.db            SQLite — SYSTEM DB: runtime only (execution_runs,
│                          checkpoints, messages, usage_logs, oauth_tokens).
│                          AI never touches this directly.
├── companies/             Per-company data (mostly YAML, plus per-team SQLite).
│   └── {company-slug}/
│       ├── company.yaml                   org chart
│       ├── teams/
│       │   └── {team-slug}/
│       │       ├── team.yaml              team config (schemas, permissions)
│       │       ├── data.db                TEAM DATA DB — SQLite + JSON1 hybrid
│       │       │                          (domain tables, populated/edited by AI)
│       │       └── dashboard.yaml         UI layout (v2 template system)
│       └── presets/
├── skills/                Claude skill format (SKILL.md + scripts/ + reference/)
├── artifacts/             Generated files — {company}/{team}/{run_id}/*
└── config.yaml            Global config (provider keys, server settings)
```

Rules:
- **System DB vs team data DB are strictly separated.** `openhive.db` = engine runtime; `data.db` = user domain data. Do not store domain data in the system DB, and do not put engine state in team DBs. Backup/portability works one team at a time (`cp -r teams/{team}`).
- Design data (companies/, skills/) is static, Git-versionable, user-shareable.
- Runtime data (openhive.db, artifacts/) is local, private, not committed.
- Artifacts live on disk; SQLite stores only path + metadata references.
- **Team data DB uses SQLite + JSON1 hybrid**: template-defined typed columns + a `data` JSON column for AI-driven extension fields. Runtime DDL (`CREATE TABLE`, `ALTER TABLE`) is allowed for AI, gated by team permission. Every schema change is logged in a `schema_migrations` table so it can be traced/rolled back.

## Repository Layout (planned)

```
openhive/
├── apps/
│   ├── server/            FastAPI backend (Python)
│   └── web/               Next.js frontend (TypeScript)
├── packages/
│   ├── skills/            Curated skill library (ships with OpenHive)
│   └── presets/           Built-in company/team presets
├── docs/
│   └── superpowers/specs/ Design specs and implementation plans
└── scripts/               CLI entry (`openhive serve`, etc.)
```

## Common Commands

Commands will be added here once the initial scaffolding lands. Placeholder targets:

- `openhive serve` — start the local server (FastAPI + Next.js dev mode or prebuilt)
- `pytest` / `uv run pytest` — backend tests
- `pnpm test` / `pnpm dev` — frontend dev and tests
- `ruff check` + `mypy` — Python lint/type
- `biome check` — frontend lint/format

## Authentication

Default: no auth, bound to `localhost` only. When started with `--host 0.0.0.0`, a password is required (enforced by the server — do not weaken this). Multi-user support is explicitly out of MVP scope.

## Runtime Topology & Port

Default port: **`4483`** (HIVE on a phone keypad).

Production mode (`openhive serve`): **one process, one port.** FastAPI serves both the Next.js prebuilt static bundle and the API/WS routes from `:4483`. No Node.js runtime required on the user's machine — the web bundle is built upstream and packaged with the Python distribution.

Development mode (`openhive serve --dev`): two processes. Next.js dev server on `:4483` (developer entry point) proxies `/api` and `/ws` to FastAPI on `:4484`. Do not change this split — hot reload depends on it.

Distribution: install script is primary, Docker image is optional. Never require Docker. Native binaries/installers are v2+.

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
