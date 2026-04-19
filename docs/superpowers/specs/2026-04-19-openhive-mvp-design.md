# OpenHive MVP — Design Spec

**Date:** 2026-04-19
**Status:** Approved for implementation planning

## 1. Project Identity

OpenHive is an open-source AI agent orchestration platform that lets a single user design hierarchical "companies" of AI agents and assign them work. Agents are arranged on a visual canvas (org chart) with reporting lines; they coordinate through a custom async engine that expresses delegation as LLM tool calls, and produce document artifacts (PPTX, DOCX, PDF, etc.) via a Claude-compatible skill system.

Primary use cases:
- Report generation (research → validation → writing)
- R&D workflows (e.g., semiconductor research, literature review, experiment planning)
- Any domain where layered delegation and document output matter

Design philosophy:
- **Local-first, self-hosted, single-user.** No cloud dependency, no signup. `openhive serve` on the user's machine, web UI connects to it.
- **Headless core, swappable clients.** The server exposes a clean HTTP/WebSocket API; the web UI is the reference client, and CLI/TUI/mobile can be added later without rearchitecting.
- **One canvas for design and execution.** Users draw the org chart in Design mode, then toggle to Run mode to watch the same chart come alive with real-time state.
- **"Real company" metaphor.** Multiple companies, each with multiple teams, each team with agents, reporting lines, and its own set of triggers.

## 2. Architecture Overview

```
┌──────────────────────────────────────────┐
│ Web UI (Next.js 16 + React 19)           │  browser
├──────────────────────────────────────────┤
│ OpenHive Server (Python 3.14 + FastAPI)  │  `openhive serve`
│ ├─ Engine (custom async orchestrator)    │
│ │   - Run state + checkpoint/resume      │
│ │   - Typed Event bus → SSE/WS           │
│ ├─ Tool Layer                            │
│ │   - Delegation tools (multi-agent)     │
│ │   - Skill tools (subprocess)           │
│ │   - MCP tools (external servers)       │
│ │   - Per-provider format translation    │
│ ├─ Provider Layer (direct httpx)         │
│ │   - OAuth: Claude Code, Codex, Copilot │
│ │   - API Key: Anthropic, OpenAI, …      │
│ │   - Local: Ollama, LM Studio           │
│ ├─ Trigger Manager (chat/cron/webhook/   │
│ │                   file/manual)         │
│ └─ Event stream (SSE + WebSocket)        │
├──────────────────────────────────────────┤
│ Skill Runtime (subprocess isolation)     │
│ └─ Python / Node scripts                 │
└──────────────────────────────────────────┘
```

Communication: Browser ↔ Server over HTTP for CRUD and SSE/WebSocket for live run events. Server ↔ Skill scripts via subprocess with permission prompts gating dangerous operations. No LangChain/LangGraph — the engine, tool layer, and provider calls are plain httpx + pydantic, so provider quirks (OAuth proxies, non-standard token exchange) are first-class rather than patched onto someone else's abstraction.

Tech stack (versions pinned to latest stable as of 2026-04-19):

| Layer | Technology | Version |
|---|---|---|
| Backend runtime | Python | 3.14.3 |
| Backend framework | FastAPI | 0.136.0 |
| HTTP client (all LLM calls) | httpx | latest |
| Orchestration | Custom async engine (in-repo) | — |
| Data modeling | pydantic | 2.9+ |
| Secrets | cryptography (Fernet) | latest |
| Persistence (runtime) | SQLite (runs, checkpoints, messages, tokens) | 3.45+ |
| Frontend runtime | Node.js | 24.15.0 LTS |
| Frontend framework | Next.js (App Router) | 16.2.4 |
| UI library | React | 19.2.5 |
| Canvas | @xyflow/react (React Flow) | 12.10.2 |
| Styling | Tailwind CSS | 4.2.2 |
| Icons | @phosphor-icons/react | 2.1.10 |
| Language | TypeScript | 5.x latest |
| Skill libraries (Python) | python-pptx, python-docx, reportlab, pypdf, weasyprint, pandoc | latest |

Security-sensitive dependencies (Next.js, FastAPI/Starlette, httpx, cryptography, OAuth libs) track `latest` via Renovate/Dependabot — never pin outdated versions.

**Explicitly rejected:** LangChain and LangGraph. We already bypass LangChain's ChatModel adapters because OAuth-subscription providers (Claude Code, Codex, Copilot) need custom 2-stage token dances that don't fit the adapter model. LangGraph's static computation graph also maps poorly onto OpenHive's runtime-dynamic delegation (Lead decides who gets a task at run time, not at graph compile time). Peer projects in this space — OpenClaw, Paperclip, 9Router — all forgo LangChain for the same reasons. See §15 for the engine design that replaces it.

## 3. Domain Model

```
Company (many per installation)
 └─ Team (many per company)
     ├─ Nodes: Agent
     │   ├─ role (e.g., CEO, Researcher, Writer)
     │   ├─ systemPrompt
     │   ├─ provider (OAuth | API key | Local)
     │   ├─ model (provider-specific model name)
     │   └─ skills: [skill_id, …]
     ├─ Edges: ReportingLine (who reports to whom)
     ├─ Triggers: [chat, cron, webhook, file_watch, manual]
     └─ Runs: ExecutionRun
         ├─ checkpoints (engine state snapshots between steps)
         ├─ events    (typed event log — drives Run-mode UI)
         ├─ messages  (agent-to-agent communication)
         └─ artifacts (file paths produced during the run)
```

Reporting edges are NOT computation edges. At run time the Lead's LLM sees a `delegate_to(assignee, task)` tool whose `assignee` enum is exactly the set of direct reports defined by the edges. Delegation is therefore a **runtime decision the LLM makes**, not a hard-coded graph transition — but the org chart still strictly constrains who can talk to whom.

## 4. Persistence

```
~/.openhive/
├── openhive.db                    SQLite — runtime only
│   ├── execution_runs
│   ├── checkpoints                engine state snapshots between steps
│   ├── run_events                 typed event log (drives Run mode + Timeline)
│   ├── messages
│   ├── usage_logs                 tokens, estimated cost per provider
│   └── oauth_tokens               encrypted
├── companies/                     YAML — definitions, Git-friendly
│   └── {company-slug}/
│       ├── company.yaml
│       ├── teams/{team-slug}.yaml
│       └── presets/               per-company custom presets
├── skills/                        Claude skill format
│   └── {skill-id}/
│       ├── SKILL.md
│       ├── scripts/
│       └── reference/
├── artifacts/                     generated files
│   └── {company}/{team}/{run_id}/*
└── config.yaml                    global settings (provider keys, server opts)
```

Separation rule: static definitions (companies/, skills/) are versionable and shareable; runtime state (openhive.db, artifacts/) is local and private. Artifacts live on the filesystem; the database stores only path and metadata.

## 5. Skill System

- **Format:** 100% compatible with Claude's skill format — `SKILL.md` frontmatter + markdown body + optional `scripts/` and `reference/` directories.
- **Bundled skills:** The OpenHive repo ships with a curated library authored by the maintainer using Claude's skill-creator externally and committed to `packages/skills/`. These are copied into `~/.openhive/skills/` on first install.
- **User-added skills:** Users drag a folder or zip into the UI; the server validates the SKILL.md and copies the contents into `~/.openhive/skills/`.
- **MCP server support:** MCP servers can be registered as tool sources alongside skills, giving agents access to external systems (Notion, Slack, etc.).
- **Execution:** Skills run as subprocesses. Dangerous operations (filesystem writes outside the artifact dir, network calls to arbitrary hosts, shell access) trigger a permission prompt in the UI (Claude Code style). Docker-based sandboxing is out of MVP scope.
- **In-app Skill Creator:** Out of MVP scope. v2+.

## 6. Organization Creation (3 entry points)

1. **Presets** — curated templates ("Report Team", "R&D Team", "Code Review Team"). One click → team is instantiated and ready to run. Primary onboarding path.
2. **Natural language** — user types "set up a semiconductor R&D team"; a built-in meta-agent designs the org chart and places agents on the canvas. User can then edit.
3. **Drag & drop canvas** — blank canvas. User drags agent nodes from a palette, connects them with reporting lines, configures each node. Primary experience for power users.

All three routes produce the same underlying YAML team definition.

## 7. UI Layout

```
┌─────────────────────────────────────────────────┐
│ [OpenHive] Company ▼ Team ▼    [Design ⇄ Run]   │
├──────┬──────────────────────────┬──────────────┤
│      │                          │              │
│ Nav  │                          │  Right       │
│ ├ Co │     Org Chart Canvas     │  Drawer      │
│ ├ Tm │     (Paperclip style,    │  (tabs):     │
│ └ …  │      @xyflow/react)      │  • Chat      │
│      │                          │  • Triggers  │
│      │                          │  • Artifacts │
├──────┴──────────────────────────┴──────────────┤
│  Timeline (collapsible) — running tasks as Gantt │
└─────────────────────────────────────────────────┘
```

**Canvas modes (single canvas, two modes):**
- **Design mode:** drag to add/move/connect nodes. Right-click or side panel to set role, provider, model, skills, system prompt. Save serializes to YAML.
- **Run mode:** active nodes pulse. Reporting-line edges animate when messages flow. Each node shows a current-activity summary bubble. User can still edit in Design mode mid-run; changes apply to the next run.

**Right drawer tabs:**
- **Chat:** team-scoped conversation. Messages default to the Lead/entry node. `@node-name` to address a specific agent. Each message acts as an immediate execution trigger.
- **Triggers:** list of scheduled/automated triggers for this team, with CRUD.
- **Artifacts:** files produced by this team's runs, grouped by run.

**Node selection:** clicking a node swaps the right drawer into that agent's detail view (logs, messages sent/received, config, history).

## 8. Triggers

A team can have any number of triggers, each independently configured:

| Type | Behavior |
|---|---|
| 💬 Chat | User types in the team chat → message goes to Lead (or `@agent`) → new ExecutionRun starts |
| ⏰ Cron | Scheduled recurrence (e.g., weekly report) → run starts automatically with a stored goal |
| 🪝 Webhook | Inbound HTTP POST to `/webhook/{team-id}` → payload becomes the run input |
| 📁 File watch | Monitored directory; new file → run starts with file path as input |
| 🔘 Manual | Saved run config with a one-click "Run now" button |

Triggers are stored in the team's YAML. The Trigger Manager in the server schedules cron jobs (APScheduler or similar), exposes webhook routes, and runs file watchers (watchdog).

## 9. Providers & Models

Three-tier provider plugin layer, each implemented as a focused module that speaks the provider's real wire protocol directly via `httpx` — no adapter library:

- **OAuth providers** — Claude Code, OpenAI Codex, GitHub Copilot, Gemini CLI. Users log in once; tokens are encrypted with Fernet and stored in SQLite. Each provider module handles its own 2-stage token dance where required (e.g. Copilot's short-lived `/copilot_internal/v2/token` refresh). Client IDs and endpoints follow 9router's public mapping.
- **API key providers** — Anthropic, OpenAI, Gemini, Groq, Mistral, Fireworks, etc. Keys stored encrypted in SQLite (or `config.yaml`). Direct calls against each provider's chat-completions endpoint.
- **Local providers** — Ollama, LM Studio, vLLM. Direct calls against localhost endpoints (all OpenAI-compatible enough that one shared module covers them).

All providers expose the same internal interface to the engine: `async stream_chat(model, messages, tools) -> AsyncIterator[Delta]`. `Delta` is a pydantic union covering text chunks, tool calls, and errors. Provider-specific response shapes are normalized inside each module.

**Per-node model selection:** each agent in the canvas specifies its own provider + model. A team can mix providers freely (e.g., CEO on Claude Opus 4.7 via OAuth, Workers on gpt-5-mini via Copilot OAuth, Reviewer on a local Ollama model).

**Legal positioning of OAuth providers:** the OAuth layer is structured as an optional plugin layer, not a coupled core feature. README includes "use at your own risk, respect provider ToS". Marketing never frames this as subscription bypass.

## 10. Authentication

- **Default:** no authentication. Server binds to `127.0.0.1` only. Any connection from localhost is the single owner.
- **Remote mode:** starting with `--host 0.0.0.0` (or non-loopback bind) requires a password set via `openhive set-password`. The server refuses to start in remote mode without one.
- **Multi-user / RBAC:** explicitly out of MVP scope.

## 10a. Deployment & Runtime Topology

**Default port: `4483`** (HIVE on a phone keypad: H=4, I=4, V=8, E=3). Chosen to avoid conflicts with Next.js dev (3000), FastAPI default (8000), Paperclip (3100), and OpenClaw (18789).

**Production (user) runtime — single process, single port:**

```
http://localhost:4483
       │
       ▼
FastAPI process (one process, serves everything)
 ├─ GET /             → Next.js prebuilt static bundle (UI)
 ├─ GET /_next/*      → JS/CSS static assets
 ├─ /api/*            → REST API
 └─ /ws               → WebSocket event stream
```

The Next.js frontend is built at package time (`next build` → static export) and bundled into the Python package. At runtime, only a single Python process runs. No Node.js process is required on the user's machine at runtime.

**Development runtime — two processes, hot reload:**

```
http://localhost:4483  ← Next.js dev server (developer entry point)
       │
       └─ /api, /ws requests proxied to →  http://localhost:4484 (FastAPI)
```

Developers still open `localhost:4483`; the Next.js dev server proxies API/WS traffic to FastAPI on 4484 transparently. `openhive serve --dev` starts both; `openhive serve` starts production mode.

**Distribution plan (MVP):**

- **Primary:** install script (`curl install.sh | sh`) — sets up Python venv, installs the `openhive` CLI, downloads the prebuilt static web bundle. Users need Python 3.14 on their machine; Node.js is NOT required at runtime (only at build time, which is handled upstream).
- **Secondary:** optional Docker image for users who prefer container isolation or team-server deployment (`docker run -p 4483:4483 -v ~/.openhive:/data openhive/openhive`). Docker is never required.
- **Out of MVP scope:** single-file native binary (PyInstaller) and native installers (.app/.exe/AppImage) — deferred to v2+ once real users validate the setup flow.

## 11. Tech Stack (summary)

See Architecture Overview section 2 for full version table. All versions are the latest stable as of 2026-04-19 and security-critical packages track `latest` via automated PRs.

## 12. Repository Layout

```
openhive/
├── apps/
│   ├── server/                 FastAPI backend
│   │   ├── openhive/
│   │   │   ├── api/            HTTP + SSE + WebSocket routes
│   │   │   ├── engine/         Orchestrator, run state, checkpoint/resume
│   │   │   ├── events/         Typed event schema + event bus
│   │   │   ├── tools/          Tool registry, per-provider format,
│   │   │   │                   delegation + skill + mcp adapters
│   │   │   ├── providers/      Direct httpx modules per provider
│   │   │   ├── auth/           OAuth flow registry + PKCE helpers
│   │   │   ├── skills/         Registry + loader + subprocess runner
│   │   │   ├── triggers/       Cron, webhook, file watch, chat
│   │   │   └── persistence/    SQLite schemas, YAML loaders, crypto
│   │   └── tests/
│   └── web/                    Next.js frontend
│       ├── app/                App Router pages
│       ├── components/         Canvas, drawers, modals, ui primitives
│       ├── lib/                API client, stores, types, mocks
│       └── tests/
├── packages/
│   ├── skills/                 Curated skills shipped with OpenHive
│   └── presets/                Built-in company/team presets
├── scripts/                    CLI entry (openhive serve, set-password, …)
└── docs/
    └── superpowers/specs/      Design specs, implementation plans
```

## 13. Out of MVP Scope (deferred to v2+)

- In-app Skill Creator (maintainer builds skills with Claude's skill-creator externally)
- Multi-user accounts and RBAC
- Docker-based skill sandboxing
- Skill marketplace / community sharing platform
- Native desktop or mobile clients
- Cloud-hosted SaaS deployment

## 14. Open Questions for Implementation

These emerged during design and should be resolved during planning, not here:

- Which ASGI server (uvicorn vs hypercorn vs granian)?
- Monorepo tool: pnpm workspaces only, or Turborepo / Nx?
- Python project tool: uv vs poetry vs hatch?
- Authentication token storage: separate encryption key or OS keychain?
- Exact engine event schema (shape of streamed events for the UI Run mode + Timeline).
- Retry/backoff strategy for provider calls (inline vs `tenacity`).

## 15. Engine Design (replaces the LangGraph decision)

The orchestrator is a plain async Python module, ~500–700 lines total. It has three layers:

**Runner (`engine/run.py`)**
- Entry point: `Engine.run(team, goal, on_event) -> AsyncIterator[Event]`.
- Builds the initial `RunState` (goal, history, working nodes), persists it to SQLite, and starts the Lead node.
- For each node step:
  1. Assemble the LLM request: system prompt + message history + tools offered to this node.
  2. Stream response via the provider module; yield typed Events as tokens and tool calls arrive.
  3. If the response contains tool calls, execute them (possibly in parallel) and feed results back as `tool_result` messages.
  4. Repeat until the node's LLM emits a final message without tool calls.
- Delegation tools that spawn subordinate runs are awaited; their nested event streams are forwarded.
- Between every top-level step the current `RunState` is checkpointed to SQLite. `resume(run_id)` replays from the latest checkpoint.

**Tools (`tools/`)**
- `Tool` is a pydantic model with `id`, `description`, `parameters` (JSON Schema), and an async `handler`.
- `ToolRegistry` serves the right subset to each node (intersection of agent's configured skills, the agent's direct-reports as delegation targets, and any registered MCP tools).
- `formats.py` translates the registry's `Tool` list into each provider's expected shape (OpenAI function-calling for Copilot/Codex; Anthropic `tool_use` blocks for Claude Code) and reverse-normalizes the response.
- Three built-in tool families ship with the engine:
  - **Delegation** — `delegate_to(assignee, task)`, injected dynamically per-node based on the org chart. This is how multi-agent coordination emerges without a static graph.
  - **Skills** — each registered skill becomes a tool whose handler spawns the subprocess + streams stdout as a `tool_result` (Phase 1).
  - **MCP** — MCP servers are surfaced as tools by proxying their `tools/list` and `tools/call` RPC (Phase 2).

**Events (`events/`)**
- Typed pydantic union: `RunStarted`, `NodeStarted`, `Token`, `ToolCalled`, `ToolResult`, `NodeFinished`, `DelegationOpened`, `DelegationClosed`, `Checkpoint`, `RunFinished`, `RunError`.
- Event bus writes every event to `run_events` SQLite table AND fans out to live subscribers (SSE for the focused team, WebSocket for global dashboards). The Timeline and Run-mode canvas read from this stream.

**Why this is enough**
- Checkpoint/resume is ~80 lines on top of `RunState` (serialize to JSON, insert; on resume, load latest + re-enter event loop).
- Parallel fan-out = `asyncio.gather(*[run_subordinate(...) for ...])`. Our graphs are shallow; the hard cases LangGraph exists to solve don't appear here.
- HITL = an approval tool whose handler `await`s on an asyncio Future that the UI resolves via a separate endpoint.
- Observability = the `run_events` table IS the trace. We don't need LangSmith; the Timeline tab IS the trace viewer.

---

*Approved by user on 2026-04-19 (v2 after LangGraph rejection). Next step: implementation plan via the writing-plans skill.*
