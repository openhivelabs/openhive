# Python → TypeScript Migration Spec

**Started:** 2026-04-21
**Owner:** Claude Opus 4.7 under ddongyun
**Scope:** Move all non-skill backend code from Python (FastAPI) to TypeScript (Next.js route handlers). Shrink Python to a subprocess-only skill runtime.

## Why

Python was introduced to cover what TypeScript can't do well — file generation (PPTX, DOCX, PDF via reportlab / python-pptx / python-docx / weasyprint / pandoc) and Python-based skill subprocesses. That's the *only* justified reason to have Python in the stack.

Current state: `apps/server/openhive/` has ~10K LOC of Python handling **everything** — the engine, OAuth, persistence, MCP manager, panel mapper, scheduler, all CRUD endpoints. None of that is TS-hard. Most of it is plain HTTP/JSON/SQL plumbing that could run on Node faster and with better type sharing with the frontend.

Decision: ship Node-first. Python stays as a narrow subprocess layer for skill execution only. **This doc is the living plan; every phase is a checkpoint.**

## Target architecture

```
┌─────────────────────────────────────────────────────┐
│ Next.js 16 (Node runtime) — :4483                   │
│   apps/web/                                          │
│     app/                                             │
│       api/**/route.ts   ← new TS backend endpoints  │
│       <page routes>                                  │
│     lib/                                             │
│       server/   ← backend modules (db, engine,      │
│                   providers, oauth, mcp, panels…)   │
│       client/   ← frontend API clients, stores      │
│                                                      │
│   Single process, single port. Engine + MCP +       │
│   scheduler run as module-scope singletons cached   │
│   on globalThis (survives HMR).                     │
└──────────────────┬──────────────────────────────────┘
                   │ subprocess (stdin/stdout JSON)
                   ▼
┌─────────────────────────────────────────────────────┐
│ Python skill runner (no HTTP server)                │
│   packages/skill-runner/ (replaces apps/server/)    │
│     Invoked per-skill-call. Receives SKILL.md path  │
│     + args on stdin, streams stdout/stderr back.    │
│     Existing Python scripts under packages/skills/  │
│     stay as-is.                                      │
└─────────────────────────────────────────────────────┘
```

No more FastAPI. No more uvicorn. No split dev process. `openhive serve` → `next start` under the hood.

## Data compatibility

These files and formats are **load-bearing and must not break** during migration:

1. `~/.openhive/openhive.db` — SQLite file. TS side uses `better-sqlite3` against the same schema. WAL mode compatible.
2. `~/.openhive/encryption.key` — Fernet key. TS side uses the `fernet` npm package (compatible with Python `cryptography.fernet`).
3. `~/.openhive/companies/**/*.yaml` — org chart + team config. Parsed with `js-yaml` (already a dep).
4. `~/.openhive/companies/**/teams/**/data.db` — per-team hybrid DB. Opened the same way via `better-sqlite3`.
5. `~/.openhive/artifacts/**/*` — generated files.
6. `~/.openhive/config.yaml`, `~/.openhive/mcp.yaml` — global config.

**Non-negotiable:** if a user has a working `~/.openhive/` today, it must still work after the migration. No schema rewrites, no token re-entry, no YAML format changes.

## Staging

Migration runs **endpoint-by-endpoint**. Next.js route handlers take precedence over `next.config.ts` rewrites, so migrated paths land on the TS side while unmigrated paths still fall through to Python at `:4484`. Single dev entry point (`:4483`) stays intact.

The handoff is complete when every route in `apps/server/openhive/api/` has an equivalent `apps/web/app/api/**/route.ts`, **and** the engine/runtime singletons live on the Node side.

### Phase 1 — Foundation (this turn)

Scaffolding on the TS side. No user-visible change.

- [x] `apps/web/lib/server/config.ts` — env + data-dir resolution
- [x] `apps/web/lib/server/paths.ts` — `~/.openhive/` path helpers
- [x] `apps/web/lib/server/crypto.ts` — Fernet wrapper (load/create key, encrypt, decrypt)
- [x] `apps/web/lib/server/db.ts` — `better-sqlite3` connection + schema init + singleton caching
- [x] `apps/web/package.json` — add `better-sqlite3`, `fernet`
- [x] Port `GET /api/health` to `apps/web/app/api/health/route.ts`
- [x] Port `GET /api/usage/*` → TS (simple SQL aggregation, proves DB access path)
- [x] Proxy config stays — unmigrated paths go to Python as before

### Phase 2 — Flat CRUD (next)

Pure YAML/JSON reads, zero LLM calls. Target: all of these done before touching the engine.

- [ ] `companies` (list/save/delete company, save team)
- [ ] `dashboards` (GET/PUT per team)
- [ ] `frames` (export YAML, install, gallery)
- [ ] `files` (team file browser, read-only)
- [ ] `artifacts` (list, download)
- [ ] `snapshots`
- [ ] `tasks`
- [ ] `messages` (list per team)
- [ ] `team_data` (SQLite + JSON1 hybrid reads/writes)

### Phase 3 — Providers + OAuth

Isolated provider adapters. Each lives in `apps/web/lib/server/providers/<id>.ts` and speaks the same wire shape as the Python counterpart.

- [ ] Token storage (`lib/server/tokens.ts`) — Fernet encrypt/decrypt against `oauth_tokens`
- [ ] PKCE + device-code flows (`lib/server/oauth/*.ts`)
- [ ] Providers: `anthropic`, `openai`, `gemini`, `ollama`, `lm-studio` (API-key path)
- [ ] OAuth providers: `claude_code`, `codex`, `copilot`, `gemini_cli`
- [ ] `/api/providers/*` route handlers

### Phase 4 — Engine

The hardest. ~2.5K LOC of orchestration state machine.

- [ ] `lib/server/events/schema.ts` — typed event schema (port of `events/schema.py`)
- [ ] `lib/server/engine/team.ts` — TeamSpec, AgentSpec, edge parsing
- [ ] `lib/server/engine/run.ts` — the run loop (tool calling, delegation, streaming)
- [ ] `lib/server/engine/providers.ts` — provider dispatch layer
- [ ] `lib/server/engine/preflight.ts`, `errors.ts`, `askuser.ts`
- [ ] `lib/server/engine/run_registry.ts` — active-run state (on `globalThis`)
- [ ] SSE stream handlers at `/api/runs/*`

### Phase 5 — MCP + Panels + Scheduler

- [ ] MCP manager using `@modelcontextprotocol/sdk`
- [ ] Panel mapper (JSONPath via `jsonpath-plus`), sources, templates, cache, refresher
- [ ] Cron scheduler (using `node-cron` or plain `setInterval` driven by saved cron strings)

### Phase 6 — Skill runtime shrink

- [ ] New `packages/skill-runner/` package (Python). Takes SKILL.md path + args on stdin, invokes the skill script, streams stdout back.
- [ ] `lib/server/skills/` in TS — discovers skills from `~/.openhive/skills/` and `packages/skills/`, spawns `skill-runner` per call.
- [ ] Delete `apps/server/openhive/skills/` (both `loader.py` and `runner.py`).

### Phase 7 — Teardown

- [ ] Delete `apps/server/openhive/` entirely (keep `apps/server/README.md` as a tombstone with migration note).
- [ ] Delete `apps/server/pyproject.toml`, `uv.lock`, `.venv/`.
- [ ] Rewrite `next.config.ts` — remove `/api/:path*` rewrite.
- [ ] Update `package.json` root script: `dev` is just Next, no concurrent Python.
- [ ] `openhive serve` CLI → invokes `next start` + spawns scheduler.
- [ ] Update `CLAUDE.md` — remove Python 3.14.3 / FastAPI from the pinned stack, add Node 24.15 + TS as the runtime.
- [ ] Update architecture diagrams (requires explicit user sign-off per CLAUDE.md rule).

## Risks + mitigations

1. **Fernet key compat.** `fernet` npm package uses the same AES-128-CBC + HMAC-SHA256 scheme. Verified in Phase 1 by round-tripping a token. If incompatible, fallback is to decrypt-on-read-encrypt-on-write with an explicit one-time migration.
2. **better-sqlite3 WAL with multi-process during transition.** Both Python and Node will have the DB open during Phase 2–5. SQLite WAL supports multiple readers + one writer, but two processes both writing is fragile. Mitigation: **migrate each table end-to-end in one phase**. A phase that writes a table also owns all its reads. No partial-table handoffs.
3. **Engine singletons + HMR.** In Next dev, module reloads can duplicate engine state. Mitigation: cache on `globalThis`; every singleton factory uses the `globalThis.__openhive_{name}` pattern.
4. **Long-running runs during dev hot reload.** Accepted limitation — kill the run if its module reloads. Prod has no HMR.
5. **MCP stdio subprocesses.** Node's `child_process` is fully featured; TS MCP SDK supports stdio. Should be 1:1 with current Python behaviour.
6. **Architectural drift during migration.** Mitigation: this doc. Every phase checks items off. Every new feature goes on the TS side only — no new Python endpoints.

## Non-goals

- Performance rewrite. Migration preserves current behaviour. Optimisation comes after.
- Feature additions. Migrate-as-is. New features queue behind Phase 7 complete.
- Multi-client support. Still one client (web). CLI/TUI/mobile remain out of MVP scope.

## Rollback

If a phase breaks production badly, revert the last batch of commits and keep the Python-side route alive. Every phase is designed to be reversible by removing the TS route handler — the Python route comes back via the proxy rewrite automatically.
