import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runOne } from './runner'
import type { HookEntry } from './types'

let tmpRoot: string
let savedDataDir: string | undefined

function mkScript(name: string, body: string): string {
  const p = path.join(tmpRoot, name)
  fs.writeFileSync(p, body, { mode: 0o755 })
  fs.chmodSync(p, 0o755)
  return p
}

function entry(command: string, timeout = 5000): HookEntry {
  return { matcher: '*', command, timeout }
}

const ENV_EXTRAS = {
  OPENHIVE_HOOK_EVENT: 'PreToolUse',
  OPENHIVE_SESSION_ID: 'sess-1',
  OPENHIVE_COMPANY_ID: 'acme',
  OPENHIVE_TEAM_ID: 'team-1',
  OPENHIVE_TRANSCRIPT_PATH: '/tmp/x',
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-hooks-runner-'))
  savedDataDir = process.env.OPENHIVE_DATA_DIR
  process.env.OPENHIVE_DATA_DIR = tmpRoot
})

afterEach(() => {
  if (savedDataDir === undefined) process.env.OPENHIVE_DATA_DIR = undefined
  else process.env.OPENHIVE_DATA_DIR = savedDataDir
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('runOne', () => {
  it('pipes payload JSON into stdin and captures stdout', async () => {
    const script = mkScript('echo.sh', '#!/bin/sh\ncat\n')
    const res = await runOne(entry(script), { hello: 'world' }, ENV_EXTRAS)
    expect(res.exitCode).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({ hello: 'world' })
    expect(res.timedOut).toBe(false)
  })

  it('propagates exit 2 with stderr', async () => {
    const script = mkScript('block.sh', '#!/bin/sh\necho "blocked" 1>&2\nexit 2\n')
    const res = await runOne(entry(script), {}, ENV_EXTRAS)
    expect(res.exitCode).toBe(2)
    expect(res.stderr).toContain('blocked')
  })

  it('times out long-running scripts and reports timedOut=true', async () => {
    const script = mkScript('slow.sh', '#!/bin/sh\nsleep 5\n')
    const res = await runOne(entry(script, 200), {}, ENV_EXTRAS)
    expect(res.timedOut).toBe(true)
    expect(res.exitCode).toBeLessThan(0)
    expect(res.durationMs).toBeLessThan(3000)
  })

  it('forwards OPENHIVE_* env vars to the child', async () => {
    const script = mkScript(
      'env.sh',
      '#!/bin/sh\nprintf "%s|%s|%s|%s" "$OPENHIVE_HOOK_EVENT" "$OPENHIVE_SESSION_ID" "$OPENHIVE_DATA_DIR" "$OPENHIVE_COMPANY_ID"\n',
    )
    const res = await runOne(entry(script), {}, ENV_EXTRAS)
    const parts = res.stdout.split('|')
    expect(parts[0]).toBe('PreToolUse')
    expect(parts[1]).toBe('sess-1')
    expect(parts[2]).toBe(tmpRoot)
    expect(parts[3]).toBe('acme')
  })

  it('returns exitCode -1 when command does not exist', async () => {
    const res = await runOne(entry(path.join(tmpRoot, 'does-not-exist.sh')), {}, ENV_EXTRAS)
    expect(res.exitCode).toBeLessThan(0)
    expect(res.stderr.length).toBeGreaterThan(0)
  })

  it('emits JSON stdout payload a hook can parse downstream', async () => {
    const script = mkScript(
      'approve.sh',
      `#!/bin/sh\nprintf '{"decision":"approve","reason":"fine"}'\n`,
    )
    const res = await runOne(entry(script), {}, ENV_EXTRAS)
    expect(res.exitCode).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({ decision: 'approve', reason: 'fine' })
  })
})
