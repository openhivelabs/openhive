import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * tsx watch (v4) only auto-watches the entry script + its transitive deps
 * reported via child IPC. That IPC misses some files under lib/ on macOS,
 * so edits to e.g. lib/server/engine/session.ts did NOT trigger reload —
 * the dev server would silently serve stale code. Fix: pre-seed chokidar
 * with explicit --include globs. This test is a regression guard so a
 * future package.json cleanup doesn't drop the flags by accident.
 */
describe('dev:hono watch include globs', () => {
  const pkg = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }

  const script = pkg.scripts['dev:hono']

  it('watches lib/**/*.ts so engine / skills edits trigger reload', () => {
    expect(script).toBeDefined()
    expect(script).toMatch(/--include\s+['"]?lib\/\*\*\/\*\.ts['"]?/)
  })

  it('watches server/**/*.ts so API edits trigger reload', () => {
    expect(script).toMatch(/--include\s+['"]?server\/\*\*\/\*\.ts['"]?/)
  })

  it('still boots from server/index.ts as entry', () => {
    expect(script).toMatch(/\bserver\/index\.ts\b/)
  })
})
