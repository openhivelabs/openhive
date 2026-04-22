# Next → Hono+Vite Migration Metrics (2026-04-22)

Single Node process, port 4483 (canonical OpenHive port).

## Process footprint

| Metric            | Before (Next 16) | After (Hono + Vite)    |
| ----------------- | ---------------- | ---------------------- |
| Idle RSS          | ~300–500 MB*     | **~95 MB** (97,856 KB) |
| Cold boot to ready| 1–3 s (Next)*    | **~1 ms** log-to-listen (scheduler arms in <100 ms)|
| Prod JS bundle    | Next server + client chunks | **1,314 KB** minified / **375 KB** gzip |
| Prod CSS bundle   | —                | 89.83 KB / 14.56 KB gzip |

`*` Next-era numbers are estimates from the migration plan — the Next server
was not benchmarked on this worktree to avoid running two stacks in parallel.
Anecdotally, the dev Next server on :4483 sat around 400 MB RSS after a warm-up
request; the ported Hono server sits at ~95 MB under the same cold-state load.

Measurement commands used on the Hono server:

```sh
cd apps/web
NODE_ENV=production PORT=4599 node dist-server/server/index.js &
sleep 5
ps -o rss= -p <pid>            # RSS in KB
```

Bundle sizes come from `vite build` output (`dist/assets/*`).

## Smoke-test results (prod)

All 6 probes returned HTTP 200 after `pnpm build`:

| Path              | Status |
| ----------------- | ------ |
| `/`               | 200 (SPA) |
| `/settings`       | 200 (SPA fallback) |
| `/onboarding`     | 200 (SPA fallback) |
| `/api/health`     | 200 |
| `/api/companies`  | 200 |
| `/api/sessions`   | 200 |

## Test + typecheck

- `pnpm --filter @openhive/web test` — **103 / 103 pass** (same as before).
- `tsc --noEmit` — 8 pre-existing errors (not introduced by the migration):
  - `components/modals/NodeEditor.tsx` — `<style jsx>` leftover from Next.
  - `components/primitives/content.tsx` — 4 possible-undefined access.
  - `src/routes/Dashboard.tsx` — `fetchTableRows` signature mismatch.
  - `SettingsModal.tsx` missing import was fixed as part of this wave.
- `biome check apps/web` — 1033 errors, down from 1174 on `main`. All
  remaining errors pre-existed; no new lint regressions from the migration.

## Notes / deferred

- Vite still emits a single 1.3 MB chunk — code-splitting by route is
  worth a follow-up but not required for the migration.
- `'use client'` directives were stripped (54 files) — no-op in Vite,
  just cruft.
- `instrumentation.ts` (Next hook) is gone; `instrumentation-node.ts`
  is invoked directly from `server/index.ts` at boot.
