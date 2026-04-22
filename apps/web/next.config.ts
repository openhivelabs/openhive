import path from 'node:path'
import type { NextConfig } from 'next'

// As of the python→ts migration completion, /api/* is served entirely by
// apps/web/app/api/** route handlers. No proxy fallback, no second process.
const config: NextConfig = {
  images: { unoptimized: true },
  // Pin Turbopack's workspace root to this repo (or worktree). Without this,
  // Next infers from the nearest pnpm-workspace.yaml which — when running in
  // a git worktree under .claude/worktrees — picks the PARENT repo. Turbopack
  // then watches a scope that includes its own cache writes, causing an
  // infinite Fast Refresh rebuild loop that hammers /api/sessions/*/stream
  // and /api/artifacts every few hundred ms.
  turbopack: { root: path.resolve(__dirname, '..', '..') },
}

export default config
