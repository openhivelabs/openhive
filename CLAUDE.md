# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: OpenHive

Open-source AI agent orchestration platform. Users design "companies" — hierarchical org charts of AI agents with reporting lines — and assign them work through multiple trigger types (chat, cron, webhook, file watch). Agents coordinate via LangGraph workflows and produce artifacts (PPTX, DOCX, PDF, etc.) through a Claude-compatible skill system.

Target use cases: report generation, R&D (e.g., semiconductor research), any domain where layered delegation + document output matters.

Design philosophy: local-first, self-hosted, single-user. Headless core + swappable clients (web UI is the primary client, CLI/TUI/mobile possible later). The canvas where users design the org is the same canvas where they watch it execute — Design/Run mode toggle over one view.

## Tech Stack (pinned to latest stable as of 2026-04-19)

Backend:
- Python 3.14.3
- FastAPI 0.136.0
- httpx (every LLM call goes through it — no adapter library)
- pydantic 2.9+ (request/response models, event schema, tool schemas)
- cryptography / Fernet (encrypted OAuth tokens at rest)
- SQLite (runtime state, checkpoints, messages, events, usage, OAuth tokens)
- Custom async engine (`apps/server/openhive/engine/`) — no LangChain, no LangGraph

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
├── openhive.db            SQLite — runtime only (execution_runs, checkpoints,
│                          messages, usage_logs, oauth_tokens)
├── companies/             YAML — org chart definitions (Git-friendly, shareable)
│   └── {company-slug}/
│       ├── company.yaml
│       ├── teams/{team-slug}.yaml
│       └── presets/
├── skills/                Claude skill format (SKILL.md + scripts/ + reference/)
├── artifacts/             Generated files — {company}/{team}/{run_id}/*
└── config.yaml            Global config (provider keys, server settings)
```

Rules:
- Design data (companies/, skills/) is static, Git-versionable, user-shareable.
- Runtime data (openhive.db, artifacts/) is local, private, not committed.
- Artifacts live on disk; SQLite stores only path + metadata references.

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

## Working Notes

- Design docs live in `docs/superpowers/specs/` — always consult the latest design spec before large changes.
- OAuth provider code is a known ToS gray area. Keep it isolated as a plugin layer, document "use at your own risk" in README, never market it as subscription bypass.
- The web UI is the reference client, but the server must stay usable without it (clean HTTP/WS API — other clients come later).
