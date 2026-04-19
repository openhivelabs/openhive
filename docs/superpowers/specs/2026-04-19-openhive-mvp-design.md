# OpenHive MVP — Design Spec

**Date:** 2026-04-19
**Status:** Approved for implementation planning

## 1. Project Identity

OpenHive is an open-source AI agent orchestration platform that lets a single user design hierarchical "companies" of AI agents and assign them work. Agents are arranged on a visual canvas (org chart) with reporting lines; they coordinate through a LangGraph-based engine and produce document artifacts (PPTX, DOCX, PDF, etc.) via a Claude-compatible skill system.

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
│ ├─ LangGraph 1.1 engine (orchestration)  │
│ ├─ Provider Plugin Layer                 │
│ │   ├─ OAuth: Claude Code, Codex,        │
│ │   │        Copilot, Gemini CLI         │
│ │   ├─ API Key: Anthropic, OpenAI, …     │
│ │   └─ Local: Ollama, LM Studio          │
│ ├─ Skill Registry                        │
│ ├─ Trigger Manager (chat/cron/webhook/   │
│ │                   file/manual)         │
│ └─ WebSocket broadcaster (live events)   │
├──────────────────────────────────────────┤
│ Skill Runtime (subprocess isolation)     │
│ └─ Python / Node scripts                 │
└──────────────────────────────────────────┘
```

Communication: Browser ↔ Server over HTTP for CRUD and WebSocket for live run events. Server ↔ Skill scripts via subprocess with permission prompts gating dangerous operations.

Tech stack (versions pinned to latest stable as of 2026-04-19):

| Layer | Technology | Version |
|---|---|---|
| Backend runtime | Python | 3.14.3 |
| Backend framework | FastAPI | 0.136.0 |
| Orchestration | LangGraph | 1.1.6 |
| Persistence (runtime) | SQLite + LangGraph SqliteCheckpointer | SQLite 3.45+ |
| Frontend runtime | Node.js | 24.15.0 LTS |
| Frontend framework | Next.js (App Router) | 16.2.4 |
| UI library | React | 19.2.5 |
| Canvas | @xyflow/react (React Flow) | 12.10.2 |
| Styling | Tailwind CSS | 4.2.2 |
| Language | TypeScript | 5.x latest |
| Skill libraries (Python) | python-pptx, python-docx, reportlab, pypdf, weasyprint, pandoc | latest |

Security-sensitive dependencies (Next.js, FastAPI/Starlette, LangGraph/LangChain, OAuth libs, authlib) track `latest` via Renovate/Dependabot — never pin outdated versions.

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
         ├─ checkpoints (LangGraph state snapshots)
         ├─ messages (agent-to-agent communication)
         └─ artifacts (file paths produced during the run)
```

Each Team materializes into a LangGraph graph at run time: agent nodes → graph nodes, reporting edges → graph edges. The Lead node (or entry node) receives the initial goal; downstream nodes act based on their role prompt and the Lead's delegation.

## 4. Persistence

```
~/.openhive/
├── openhive.db                    SQLite — runtime only
│   ├── execution_runs
│   ├── checkpoints                LangGraph SqliteCheckpointer
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

Three-tier provider plugin layer, all unified through LangChain's chat model adapters:

- **OAuth providers** — Claude Code, OpenAI Codex, GitHub Copilot, Gemini CLI. Users log in once; OpenHive stores encrypted tokens in SQLite and exposes a local proxy endpoint (e.g., `/proxy/claude-code/*`) that relays requests using the OAuth token. The LangChain adapter points `base_url` at the proxy. Inspired by 9Router's approach.
- **API key providers** — Anthropic, OpenAI, Gemini, Groq, Mistral, Fireworks, etc. Keys stored in `config.yaml` (or encrypted in SQLite) and used directly by standard LangChain adapters.
- **Local providers** — Ollama, LM Studio, vLLM. Standard LangChain adapters against localhost endpoints.

**Per-node model selection:** each agent in the canvas specifies its own provider + model. A team can mix providers freely (e.g., CEO on Claude Opus 4.5 via OAuth, Workers on Haiku via API key, Reviewer on a local Ollama model).

**Legal positioning of OAuth providers:** the OAuth layer is structured as an optional plugin layer, not a coupled core feature. README includes "use at your own risk, respect provider ToS". Marketing never frames this as subscription bypass.

## 10. Authentication

- **Default:** no authentication. Server binds to `127.0.0.1` only. Any connection from localhost is the single owner.
- **Remote mode:** starting with `--host 0.0.0.0` (or non-loopback bind) requires a password set via `openhive set-password`. The server refuses to start in remote mode without one.
- **Multi-user / RBAC:** explicitly out of MVP scope.

## 11. Tech Stack (summary)

See Architecture Overview section 2 for full version table. All versions are the latest stable as of 2026-04-19 and security-critical packages track `latest` via automated PRs.

## 12. Repository Layout

```
openhive/
├── apps/
│   ├── server/                 FastAPI backend
│   │   ├── openhive/
│   │   │   ├── api/            HTTP + WebSocket routes
│   │   │   ├── engine/         LangGraph wiring, node factories
│   │   │   ├── providers/      OAuth + API key + Local plugin layer
│   │   │   ├── skills/         Registry + loader + subprocess runner
│   │   │   ├── triggers/       Cron, webhook, file watch, chat
│   │   │   └── persistence/    SQLite schemas, YAML loaders
│   │   └── tests/
│   └── web/                    Next.js frontend
│       ├── app/                App Router pages
│       ├── components/         Canvas, drawers, forms
│       ├── lib/                API client, WebSocket client
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
- Exact WebSocket event schema (shape of streamed LangGraph events for the UI).

---

*Approved by user on 2026-04-19. Next step: implementation plan via the writing-plans skill.*
