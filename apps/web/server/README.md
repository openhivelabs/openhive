# Hono API Server (Wave 1 skeleton)

This directory hosts the Hono-based HTTP API that will eventually replace the
Next.js `app/api/**` route handlers. During the migration it runs **alongside**
Next (Next on `:4483`, Hono on `:4484`) so individual resources can be ported
and verified one family at a time.

**Do not delete anything under `apps/web/app/api/` while porting.** Remove a
Next route only after its Hono counterpart ships, is tested, and all clients
have been pointed at the new path.

## Layout

```
apps/web/server/
├── index.ts              # process entry — starts @hono/node-server on :4484
├── api/
│   ├── index.ts          # mounts every resource router under /api
│   ├── health.ts         # trivial GET
│   ├── companies.ts      # GET / PUT / DELETE — representative resource
│   └── <resource>.ts     # one file per resource family
└── README.md
```

Convention: **one file per resource family** under `server/api/`, exporting a
`Hono` sub-app. Register it in `server/api/index.ts` with `api.route('/x', x)`.
Nested collections (e.g. `/companies/:id/teams`) live in the parent resource's
file unless the child has >~5 handlers of its own, in which case it gets its
own file and is mounted under the parent.

## Run

```bash
pnpm --filter @openhive/web dev:hono         # defaults to 127.0.0.1:4484
HONO_PORT=5000 HOST=0.0.0.0 pnpm dev:hono    # override
```

OpenHive's long-term plan keeps one port (4483) for production. The :4484
split is a Wave-1-only dev affordance; later waves collapse back onto 4483
once the Next API surface is empty.

## Conversion rules (Next App Router → Hono)

| Next                                                 | Hono                              |
| ---------------------------------------------------- | --------------------------------- |
| `NextResponse.json(x)`                               | `c.json(x)`                       |
| `NextResponse.json(x, { status: 400 })`              | `c.json(x, 400)`                  |
| `await request.json()`                               | `await c.req.json()`              |
| `new NextResponse(stream, { headers })`              | `return new Response(stream, { headers })` or `c.body(stream)` |
| `[slug]` folder segment                              | `:slug` in the route path         |
| `ctx.params` (async in Next 15+)                     | `c.req.param('slug')` (sync)      |
| `request.nextUrl.searchParams.get('q')`              | `c.req.query('q')`                |
| `request.headers.get('x-foo')`                       | `c.req.header('x-foo')`           |
| `export const runtime = 'nodejs'`                    | (drop — Hono runs on Node always) |
| `export const dynamic = 'force-dynamic'`             | (drop)                            |
| Top-of-handler `requireAuth()` call                  | Hono middleware (see Auth)        |

**Errors.** Keep the existing `{ detail: '...' }` shape that Next handlers
already return so clients don't have to change. Don't invent new error envelopes
during the port — that's a separate refactor.

**Business logic.** Re-import from `@/lib/server/**` exactly as the Next route
did. Do not touch those modules in this wave; a faithful port is the whole
point.

## Example: trivial GET

**Before** (`apps/web/app/api/health/route.ts`):

```ts
import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET() {
  return NextResponse.json({ status: 'ok', version: '0.0.1' })
}
```

**After** (`apps/web/server/api/health.ts`):

```ts
import { Hono } from 'hono'
export const health = new Hono()
health.get('/', (c) => c.json({ status: 'ok', version: '0.0.1' }))
```

Mounted in `server/api/index.ts` with `api.route('/health', health)`, giving
`GET /api/health`.

## Example: POST/PUT with body validation

**Before**:

```ts
export async function PUT(req: Request) {
  const body = (await req.json()) as SaveCompanyBody
  const company = body?.company
  if (!company || typeof company !== 'object') {
    return NextResponse.json({ detail: 'company body required' }, { status: 400 })
  }
  saveCompany(company)
  return NextResponse.json({ ok: true })
}
```

**After**:

```ts
companies.put('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SaveCompanyBody
  const company = body?.company
  if (!company || typeof company !== 'object') {
    return c.json({ detail: 'company body required' }, 400)
  }
  saveCompany(company)
  return c.json({ ok: true })
})
```

Note the `.catch(() => ({}))` — `c.req.json()` throws on empty/invalid JSON;
Next's `request.json()` does the same but the idiom below is safer when the
route treats missing body as a 400 anyway.

## Example: URL parameter route

**Before** (`apps/web/app/api/companies/[companySlug]/route.ts`):

```ts
export async function DELETE(_req: Request, ctx: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await ctx.params
  const ok = deleteCompany(companySlug)
  if (!ok) return NextResponse.json({ detail: 'Company not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
```

**After** (same file as the parent resource):

```ts
companies.delete('/:companySlug', (c) => {
  const companySlug = c.req.param('companySlug')
  const ok = deleteCompany(companySlug)
  if (!ok) return c.json({ detail: 'Company not found' }, 404)
  return c.json({ ok: true })
})
```

## Auth

OpenHive's current MVP binds to `127.0.0.1` and has no per-request auth;
password enforcement only kicks in for `--host 0.0.0.0`. When later waves
port routes that *do* need auth, express it as Hono middleware on the
resource sub-app (not per handler):

```ts
export const tasks = new Hono()
tasks.use('*', async (c, next) => {
  // pull session from cookie / header, attach to c.set('user', ...)
  await next()
})
tasks.get('/', handler)
```

Use `c.set`/`c.get` to pass auth context to handlers. Do not sprinkle
`requireAuth()` calls at the top of each handler — that's the pattern we're
leaving behind.

## SSE / streaming

Use Hono's `streamSSE` helper from `hono/streaming` rather than hand-rolling a
`ReadableStream`:

```ts
import { streamSSE } from 'hono/streaming'

sessions.get('/:id/events', (c) =>
  streamSSE(c, async (stream) => {
    for await (const event of engineEvents(c.req.param('id'))) {
      await stream.writeSSE({ data: JSON.stringify(event) })
    }
  }),
)
```

See `server/api/sessions.ts` once Wave 2 ports the engine routes.

## Testing convention

Each resource file gets a sibling `<resource>.test.ts`. Use Hono's
`app.fetch(new Request(...))` directly — no HTTP server, no port:

```ts
import { describe, expect, it } from 'vitest'
import { api } from './index'

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await api.fetch(new Request('http://local/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', version: '0.0.1' })
  })
})
```

For routes that touch the filesystem / SQLite, mock at the `@/lib/server/**`
boundary rather than the handler — same rule as Next-era tests.

## Checklist for each ported route

1. Re-read the Next handler; list every status code and response shape.
2. Write the Hono handler; keep error envelopes identical.
3. Register it in `server/api/index.ts` (only needed for new resource files).
4. Hit it with `curl localhost:4484/api/...` and diff against `curl localhost:4483/api/...`.
5. Add a `.test.ts` using `app.fetch()`.
6. `pnpm exec biome check --write apps/web/server/` and
   `pnpm --filter @openhive/web exec tsc --noEmit`.
7. Only now remove the Next handler — and update any frontend client that
   hardcoded `/api/...` to respect the current port routing rules.
