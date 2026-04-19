# Phase 0B — Backend + Single-Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Stand up the FastAPI server on `:4484` (dev) and wire the existing frontend
ChatTab to a real LLM so typing a message in the UI makes a live model call and streams
the response back. No LangGraph, no orchestration, no persistence beyond messages yet.

**Architecture:** FastAPI + uv/pip-managed Python 3.14. Pydantic request/response models.
LangChain adapters (`ChatAnthropic`, `ChatOpenAI`) behind a tiny provider layer. Single
`POST /api/chat/stream` endpoint using Server-Sent Events. Next.js dev server proxies
`/api` to `:4484`. Production (single-port `:4483`) comes in a later phase.

**Tech Stack:** Python 3.14, FastAPI 0.136, uvicorn, LangChain (anthropic + openai),
pydantic-settings, python-dotenv, SSE (native FastAPI `StreamingResponse`).

**Scope:** Backend comes up, one agent (hardcoded from currentTeam's Lead) answers real
LLM calls over SSE. User sees streaming tokens. No multi-agent coordination (Phase 0C).

---

## File Structure

```
openhive/
├── apps/
│   └── server/
│       ├── pyproject.toml
│       ├── openhive/
│       │   ├── __init__.py
│       │   ├── main.py              FastAPI app, CORS, include routers
│       │   ├── config.py            Settings (ports, API keys) via pydantic-settings
│       │   ├── providers/
│       │   │   ├── __init__.py
│       │   │   ├── base.py          `Provider` protocol + `ChatRequest` / streaming
│       │   │   ├── anthropic.py     LangChain ChatAnthropic wrapper
│       │   │   ├── openai.py        LangChain ChatOpenAI wrapper
│       │   │   └── registry.py      resolve(provider_id) -> Provider
│       │   └── api/
│       │       ├── __init__.py
│       │       ├── health.py        GET /api/health
│       │       └── chat.py          POST /api/chat/stream (SSE)
│       └── tests/
│           └── test_health.py
└── apps/web/
    └── next.config.ts               add rewrite: /api/* -> :4484/api/*
```

Root `pyproject.toml` stays pnpm-only. The Python project is self-contained under
`apps/server/` so TypeScript tooling ignores it.

---

## Task 1: Python project scaffold

**Files:**
- Create: `apps/server/pyproject.toml`, `apps/server/.python-version`, `apps/server/openhive/__init__.py`, `apps/server/openhive/main.py`, `apps/server/openhive/config.py`, `apps/server/openhive/api/__init__.py`, `apps/server/openhive/api/health.py`
- Create: `apps/server/README.md`

- [ ] **Step 1: `apps/server/pyproject.toml`** — declares `openhive` package, deps:
  - fastapi==0.136.0
  - uvicorn[standard]>=0.30
  - pydantic>=2.9
  - pydantic-settings>=2.6
  - python-dotenv>=1.0
  - langchain>=0.3
  - langchain-anthropic>=0.3
  - langchain-openai>=0.3

- [ ] **Step 2: `apps/server/.python-version`** → `3.14`

- [ ] **Step 3: `config.py`** — `Settings` with `host='127.0.0.1'`, `port=4484`, `anthropic_api_key`, `openai_api_key` loaded from env/`.env`.

- [ ] **Step 4: `api/health.py`** — router with `GET /api/health` returning `{status:"ok",version:"0.0.1"}`.

- [ ] **Step 5: `main.py`** — FastAPI app, CORS (`http://localhost:4483` allowed), mount health router, `/` returns `{service:"openhive",ok:true}`.

- [ ] **Step 6: Install + smoke test**

```bash
cd apps/server
uv venv --python 3.14
uv pip install -e .
uv run uvicorn openhive.main:app --port 4484 &
curl -s http://localhost:4484/api/health
# expect {"status":"ok","version":"0.0.1"}
kill %1
```

- [ ] **Step 7: Commit** `feat(server): scaffold FastAPI app on :4484 with health endpoint`

---

## Task 2: Provider layer

**Files:**
- Create: `apps/server/openhive/providers/__init__.py`, `base.py`, `anthropic.py`, `openai.py`, `registry.py`

- [ ] **Step 1: `base.py`** — pydantic `ChatMessage(role, content)`, abstract class `Provider` with `async stream(messages, system, model) -> AsyncIterator[str]`.

- [ ] **Step 2: `anthropic.py`** — `AnthropicProvider(Provider)` using `ChatAnthropic(model=..., anthropic_api_key=...).astream(...)` yielding text chunks.

- [ ] **Step 3: `openai.py`** — `OpenAIProvider` using `ChatOpenAI(...).astream(...)`.

- [ ] **Step 4: `registry.py`** — `resolve(provider_id) -> Provider`. Accepts `"anthropic"` / `"openai"`; raises `HTTPException(400)` otherwise. Reads keys from `Settings`.

- [ ] **Step 5: Commit** `feat(server): add provider layer with anthropic and openai adapters`

---

## Task 3: SSE chat endpoint

**Files:**
- Create: `apps/server/openhive/api/chat.py`
- Modify: `apps/server/openhive/main.py` (include chat router)

- [ ] **Step 1: `chat.py`** request model:
```python
class ChatStreamRequest(BaseModel):
    provider: str          # "anthropic" | "openai"
    model: str             # e.g. "claude-sonnet-4-6"
    system: str
    messages: list[dict]   # [{role:"user"|"assistant", content:str}]
```

- [ ] **Step 2: Endpoint** `POST /api/chat/stream` returns `StreamingResponse` with `media_type="text/event-stream"`. For each chunk from provider: `yield f"data: {json.dumps({'delta': chunk})}\n\n"`. On error: `yield f"data: {json.dumps({'error': str(e)})}\n\n"`. End with `data: [DONE]\n\n`.

- [ ] **Step 3: Smoke test with curl**

```bash
curl -N -X POST http://localhost:4484/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"claude-haiku-4-5","system":"Be concise.","messages":[{"role":"user","content":"hi"}]}'
```
Expected: streaming `data: {"delta":"..."}` lines finishing with `data: [DONE]`.

- [ ] **Step 4: Commit** `feat(server): add SSE chat stream endpoint`

---

## Task 4: Next.js rewrite to backend

**Files:**
- Modify: `apps/web/next.config.ts` (add dev rewrite)

- [ ] **Step 1**: Add rewrite so `/api/*` from `:4483` forwards to `:4484`:

```ts
const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:4484/api/:path*' }]
  },
}
```
Note: rewrites don't apply to static export at build time, but they work in `next dev`. In production we'll proxy via FastAPI instead (later phase).

- [ ] **Step 2**: Restart dev server, `curl http://localhost:4483/api/health` → `200 OK`.

- [ ] **Step 3: Commit** `feat(web): proxy /api to backend in dev mode`

---

## Task 5: Wire ChatTab to real LLM

**Files:**
- Create: `apps/web/lib/api/chat.ts` (typed client for SSE stream)
- Modify: `apps/web/components/drawer/ChatTab.tsx`

- [ ] **Step 1: `chat.ts`** — `async function* streamChat(req): AsyncIterator<string>` using `fetch` with `ReadableStream` parsing of SSE.

```ts
export interface StreamReq {
  provider: string
  model: string
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
}

export async function* streamChat(req: StreamReq, signal?: AbortSignal) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') return
      try {
        const obj = JSON.parse(payload)
        if (obj.delta) yield obj.delta as string
        if (obj.error) throw new Error(obj.error)
      } catch {
        /* ignore malformed */
      }
    }
  }
}
```

- [ ] **Step 2: `ChatTab.tsx`** — replace the `setTimeout` canned reply with real call. Resolve the current team's Lead agent (`team.agents[0]`) → provider id + model → map `providerId` to backend provider name (`p-claude` → `anthropic`, `p-openai` → `openai`). Append an empty assistant message first, then mutate its text as chunks arrive (via `updateMessage` in `useDrawerStore`).

- [ ] **Step 3: Add `updateMessage` to `useDrawerStore`**

```ts
updateMessage: (id, patch) =>
  set((s) => ({
    messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  })),
```

- [ ] **Step 4: Providers → backend-id mapping helper** (in `apps/web/lib/mock/companies.ts` or new `lib/providerMap.ts`):

```ts
const MAP: Record<string, string> = {
  'p-claude': 'anthropic',
  'p-openai': 'openai',
}
export function toBackendProvider(id: string): string | null {
  return MAP[id] ?? null
}
```
If null (e.g. OAuth providers), chat tab shows a friendly "provider not supported yet" message.

- [ ] **Step 5: Env setup docs** — add to `apps/server/README.md`: set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `apps/server/.env`.

- [ ] **Step 6: Manual verify with Playwright** — type "say hello" in chat, see streaming assistant reply. Confirm console no errors.

- [ ] **Step 7: Commit** `feat(web): stream real LLM responses in chat tab`

---

## Exit Criteria

- `uvicorn` + `next dev` both run (one command `./scripts/dev` is Phase 1 polish).
- `/api/health` returns OK through the Next proxy.
- Sending a message in the ChatTab produces real streaming tokens from Anthropic (or OpenAI).
- No LangGraph, no multi-agent coordination, no persistence across sessions — those arrive in Phase 0C+.

## Out of Phase 0B scope

- Multi-agent LangGraph workflows (0C)
- YAML save/load for companies/teams (0D)
- WebSocket event bus for canvas Run mode (0E)
- Production single-port deployment (later)
- OAuth providers (Phase 2)
- Skills / artifacts generation (Phase 1)
