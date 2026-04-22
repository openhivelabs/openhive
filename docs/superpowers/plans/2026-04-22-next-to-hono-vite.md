# Next.js → Hono + Vite Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.
> **이 플랜은 1·4·5 가 merge 된 뒤 실행.**

**Goal:** Next.js 16 런타임을 걷어내고 **Hono (API) + Vite React SPA (UI)** 조합으로 교체해, 유휴 RSS 300–500MB → 80–120MB, 콜드 스타트 2–4s → 100–300ms 로 낮춘다. 기능 동일성 유지.

**Architecture:** 한 Node 프로세스가 포트 4483 에 Hono 서버 기동 → `/api/**` 는 Hono 핸들러, 그 외 경로는 Vite 로 빌드된 `apps/web/dist/**` 정적 서빙 + SPA fallback. `better-sqlite3`, MCP manager, engine, scheduler 는 그대로 — 단, Next 의 App Router / RSC / middleware 의존만 제거. 페이지는 React Router (`react-router-dom`) 로 클라이언트 라우팅.

**Tech Stack:** `hono`, `@hono/node-server`, `vite`, `@vitejs/plugin-react`, `react-router-dom`, 기존 React 19 / React Query / Zustand (그대로 유지).

---

## Scope

**In:** 62개 `/api/**` route, 약 10개 page, `globals.css`, layout. 정적 자원 serving. dev/build/start 스크립트.

**Out:** 엔진·MCP·skill runner·SQLite·YAML I/O·OAuth — 전부 그대로. 프론트 디자인/기능 변경 금지.

---

## File Structure

- **Create** `apps/web/server/index.ts` — Hono 서버 엔트리 (prod 서빙 + api 라우터)
- **Create** `apps/web/server/api/index.ts` — 모든 api route 등록 허브
- **Create** `apps/web/server/api/<resource>.ts` — 리소스별 Hono 라우터 (62개 route 를 ~15개 파일로 묶음)
- **Create** `apps/web/vite.config.ts` — React + dev proxy (api 는 Hono 로 포워드)
- **Create** `apps/web/src/main.tsx` — React 엔트리
- **Create** `apps/web/src/App.tsx` — React Router v7 data router
- **Create** `apps/web/src/routes/**` — 기존 `app/**/page.tsx` 를 포팅
- **Create** `apps/web/index.html` — Vite entry
- **Modify** `apps/web/package.json` — scripts, deps 교체
- **Delete** `apps/web/next.config.ts`, `apps/web/app/**` (모든 포팅 완료 후)
- **Modify** 루트 `package.json` / `turbo.json` — build pipeline

---

## Task 1: 조사 & 인벤토리

- [ ] **Step 1**: 라우트 인벤토리
```bash
find apps/web/app/api -name route.ts | sort > /tmp/routes.txt
wc -l /tmp/routes.txt  # 62 예상
```
`/tmp/routes.txt` 를 이 문서 아래 Appendix A 로 붙여넣기. 각 route 의 HTTP 메서드, body/response 타입을 주석으로 한 줄씩.
- [ ] **Step 2**: 페이지 인벤토리
```bash
find apps/web/app -name page.tsx -o -name layout.tsx | sort > /tmp/pages.txt
```
- [ ] **Step 3**: Next-specific API 사용 검색
```bash
grep -rn "next/server\|next/headers\|next/navigation\|next/image\|next/link\|NextResponse\|NextRequest\|cookies()\|headers()\|notFound()\|redirect(" apps/web --include="*.ts" --include="*.tsx" | tee /tmp/next-deps.txt
```
각 케이스를 Hono / React Router 치환 노트로 Appendix B 에 기록.
- [ ] **Step 4**: commit (인벤토리 문서만) `docs: migration inventory for Hono/Vite`

## Task 2: Hono 서버 스켈레톤 (기존 Next 병존)

**Files:**
- Create: `apps/web/server/index.ts`
- Create: `apps/web/server/api/index.ts`
- Modify: `apps/web/package.json`

기존 Next 는 당분간 살려두고, 다른 포트(4484)에서 Hono 를 병렬 기동. 라우트를 하나씩 포팅하며 diff.

- [ ] **Step 1**: 의존성
```bash
pnpm --filter @openhive/web add hono @hono/node-server
pnpm --filter @openhive/web add -D vite @vitejs/plugin-react
```
- [ ] **Step 2**: 서버 스켈레톤
```ts
// apps/web/server/index.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { api } from './api'

const app = new Hono()
app.route('/api', api)
app.get('/health', c => c.json({ ok: true }))

const port = Number.parseInt(process.env.PORT ?? '4484', 10)
serve({ fetch: app.fetch, port })
console.log(`[hono] listening on :${port}`)
```
- [ ] **Step 3**: `apps/web/server/api/index.ts`
```ts
import { Hono } from 'hono'
export const api = new Hono()
// 라우터들이 여기에 .route() 로 붙음
```
- [ ] **Step 4**: `package.json` 에 스크립트
```json
"scripts": {
  "dev:hono": "tsx watch server/index.ts",
  ...
}
```
- [ ] **Step 5**: `pnpm --filter @openhive/web dev:hono` 뜨는지 확인, `curl :4484/health` → `{"ok":true}`
- [ ] **Step 6**: commit `feat(server): Hono skeleton alongside Next`

## Task 3: API 라우트 포팅 — 첫 리소스 `health`

간단한 것부터 패턴 확립. 순서 제안: **health → usage → companies → teams → sessions → agents → mcp → providers → tasks → ai → panels/frames/artifacts/...**

**Files:** `apps/web/server/api/health.ts`, 필요 시 기존 `apps/web/app/api/health/route.ts` 참조.

- [ ] **Step 1**: 기존 Next route 읽고 로직 복사
- [ ] **Step 2**:
```ts
// server/api/health.ts
import { Hono } from 'hono'
export const health = new Hono()
health.get('/', c => c.json({ ok: true, ts: Date.now() }))
```
- [ ] **Step 3**: `server/api/index.ts` 에 등록: `api.route('/health', health)`
- [ ] **Step 4**: `curl :4484/api/health` vs `curl :4483/api/health` 응답 동치
- [ ] **Step 5**: commit `feat(server): port /api/health to Hono`

## Task 4: API 포팅 — 리소스별 반복

Appendix A 의 모든 route 를 위 Task 3 패턴으로 이식. **한 리소스 = 한 커밋.**

치환 가이드:
- `NextResponse.json(x)` → `c.json(x)`
- `NextResponse.json(x, { status: 400 })` → `c.json(x, 400)`
- `request.json()` → `await c.req.json()`
- `request.headers.get('x')` → `c.req.header('x')`
- `cookies()` (server component) → Hono 미들웨어 (`hono/cookie`)
- URL param `[id]` → Hono `:id`, `c.req.param('id')`
- Streaming (SSE) → `c.body(new ReadableStream({...}))` or `hono/streaming` 의 `streamSSE`
- 인증 미들웨어 → Hono middleware 로 이식

**절대 엔진/스킬/DB 로직은 만지지 않는다.** import 만 그대로 가져와 handler 로 재포장.

- [ ] **Step 1–N**: 리소스별 포팅. 매 리소스마다 curl/HTTP client 동치 비교 후 commit.

## Task 5: SSE / 스트리밍 경로 확인

**Files:** 세션 이벤트 스트림 라우트 (`api/sessions/[id]/events` 등)

- [ ] **Step 1**: Hono `streamSSE` 로 재구현
- [ ] **Step 2**: 브라우저에서 `EventSource` 붙였을 때 재연결 작동 확인
- [ ] **Step 3**: commit `feat(server): SSE session stream on Hono`

## Task 6: Vite + React Router 스켈레톤

**Files:** `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`

- [ ] **Step 1**: `apps/web/index.html`
```html
<!doctype html><html lang="en"><head><meta charset="UTF-8"/><title>OpenHive</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```
- [ ] **Step 2**: `vite.config.ts`
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4484' },
  },
  build: { outDir: 'dist' },
})
```
- [ ] **Step 3**: `src/main.tsx`, `src/App.tsx` — React Router v7 (`createBrowserRouter`) 로 빈 라우트 트리
- [ ] **Step 4**: 기존 `app/globals.css` 를 `src/globals.css` 로 이동 + import
- [ ] **Step 5**: `pnpm --filter @openhive/web add react-router-dom`
- [ ] **Step 6**: `vite` 띄우고 빈 페이지 로드 확인
- [ ] **Step 7**: commit `feat(web): Vite + React Router skeleton`

## Task 7: 페이지 포팅

각 `app/**/page.tsx` 를 `src/routes/**` 로 이식. 컴포넌트 자체는 그대로, 서버 전용 호출만 SSR fetch 가 아니라 **클라이언트 fetch → api** 로 전환.

순서: `page.tsx` (루트) → `onboarding` → `settings` → `[companySlug]/[teamSlug]/team` → `tasks` → `records` → `dashboard` → `new` → `s/[sessionId]`.

치환:
- `next/link` → `react-router-dom` `Link`
- `next/navigation` `useRouter().push` → `useNavigate()`
- `useSearchParams` → `useSearchParams` (react-router v7 도 동일 이름)
- `next/image` → 일반 `<img>` 또는 `@unpic/react` (필요 시)
- 서버 컴포넌트에서 직접 SQLite 조회한 로직 → 해당 데이터를 제공하는 API 라우트를 Task 4 에서 이미 포팅했으므로 `fetch('/api/...')` + React Query

- [ ] **Step 1–N**: 페이지별 포팅. 각 페이지마다 눈으로 확인 + commit.

## Task 8: 빌드 파이프라인

**Files:** `apps/web/package.json`, 루트 `turbo.json`

- [ ] **Step 1**: 스크립트 정리
```json
"scripts": {
  "dev:api": "tsx watch server/index.ts",
  "dev:web": "vite",
  "dev": "concurrently -k \"pnpm dev:api\" \"pnpm dev:web\"",
  "build:api": "tsc -p tsconfig.server.json",
  "build:web": "vite build",
  "build": "pnpm build:api && pnpm build:web",
  "start": "NODE_ENV=production node dist-server/index.js"
}
```
- [ ] **Step 2**: `tsconfig.server.json` (Hono 서버용, outDir `dist-server/`)
- [ ] **Step 3**: 프로덕션 서버: Hono 가 `apps/web/dist` (Vite 결과) 정적 서빙 + SPA fallback
```ts
// server/index.ts (prod 분기)
import { serveStatic } from '@hono/node-server/serve-static'
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', c => c.html(readFileSync('./dist/index.html','utf8')))
}
```
- [ ] **Step 4**: 포트를 4483 으로 복구 (Next 와 동거 종료 직전 단계)
- [ ] **Step 5**: commit `build: Hono+Vite pipeline`

## Task 9: Next 제거

- [ ] **Step 1**: 모든 페이지 포팅 완료 & smoke 통과 확인
- [ ] **Step 2**: `apps/web/app/` 디렉토리 삭제
- [ ] **Step 3**: `next`, `next-*`, `react-server-dom-*` 등 deps 제거
- [ ] **Step 4**: `next.config.ts`, `next-env.d.ts`, `.next/` 삭제
- [ ] **Step 5**: `biome check` & 전체 vitest PASS
- [ ] **Step 6**: commit `chore: drop Next.js`

## Task 10: 인증/보안 재점검

- [ ] **Step 1**: `--host 0.0.0.0` 비번 강제 로직 이식 확인 (CLAUDE.md 규정)
- [ ] **Step 2**: CORS, cookie secure 플래그 동등
- [ ] **Step 3**: 세션 토큰/OAuth 흐름 smoke
- [ ] **Step 4**: commit if changes

## Task 11: 측정 & PR

- [ ] **Step 1**: 유휴 RSS, 콜드 스타트, `pnpm build` 피크, 번들 크기 before/after 기록
- [ ] **Step 2**: 수용 기준
  - 모든 기능 smoke 통과 (회사 생성 → 팀 → 세션 → skill → artifact)
  - i18n (en/ko) 정상
  - SSE 재연결 정상
  - `pnpm build` 피크 2GB 이하
- [ ] **Step 3**: PR 초안

## Appendix A — 라우트 인벤토리

*(Task 1 에서 생성)*

## Appendix B — Next-specific 치환 노트

*(Task 1 에서 생성)*

## 롤백 전략

- 모든 작업을 `runtime-optimize` 브랜치의 feature 서브브랜치에서 진행, PR 단위 revert 가능.
- Task 9 (Next 제거) 전까지는 Next 병존이라 언제든 Hono 포트만 끄면 원복.
- 심각한 이슈 시 `git revert` 로 Task 9 만 되돌리고 Next 경로 재활성.
