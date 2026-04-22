import child_process from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetHookConfigCacheForTests } from './config'
import { runHooks } from './index'
import type { PreToolUsePayload, SessionStartPayload, StopPayload } from './types'

let tmpRoot: string
let savedDataDir: string | undefined
let savedDisabled: string | undefined

function mkScript(name: string, body: string): string {
  const p = path.join(tmpRoot, name)
  fs.writeFileSync(p, body, { mode: 0o755 })
  fs.chmodSync(p, 0o755)
  return p
}

function writeConfig(body: string): void {
  fs.writeFileSync(path.join(tmpRoot, 'config.yaml'), body, 'utf8')
}

function preToolPayload(sessionId = 'sess-1', toolName = 'sql_exec'): PreToolUsePayload {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    transcript_path: `${tmpRoot}/sessions/${sessionId}/transcript.jsonl`,
    cwd: process.cwd(),
    company_id: 'acme',
    team_id: 'team-1',
    data_dir: tmpRoot,
    tool_name: toolName,
    tool_input: { sql: 'drop table users' },
    agent_id: 'lead',
    depth: 0,
    tool_call_id: 'call-1',
  }
}

function stopPayload(sessionId = 'sess-1'): StopPayload {
  return {
    hook_event_name: 'Stop',
    session_id: sessionId,
    transcript_path: `${tmpRoot}/sessions/${sessionId}/transcript.jsonl`,
    cwd: process.cwd(),
    company_id: 'acme',
    team_id: 'team-1',
    data_dir: tmpRoot,
    status: 'completed',
    duration_ms: 123,
    artifact_paths: [],
    last_event_seq: 42,
    output: 'done',
    error: null,
  }
}

function sessionStartPayload(sessionId = 'sess-1'): SessionStartPayload {
  return {
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    transcript_path: `${tmpRoot}/sessions/${sessionId}/transcript.jsonl`,
    cwd: process.cwd(),
    company_id: 'acme',
    team_id: 'team-1',
    data_dir: tmpRoot,
    goal: 'do thing',
    team_snapshot: { id: 'team-1' },
    source: 'fresh',
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-hooks-idx-'))
  savedDataDir = process.env.OPENHIVE_DATA_DIR
  savedDisabled = process.env.OPENHIVE_HOOKS_DISABLED
  process.env.OPENHIVE_DATA_DIR = tmpRoot
  process.env.OPENHIVE_HOOKS_DISABLED = undefined
  __resetHookConfigCacheForTests()
})

afterEach(() => {
  if (savedDataDir === undefined) process.env.OPENHIVE_DATA_DIR = undefined
  else process.env.OPENHIVE_DATA_DIR = savedDataDir
  if (savedDisabled === undefined) process.env.OPENHIVE_HOOKS_DISABLED = undefined
  else process.env.OPENHIVE_HOOKS_DISABLED = savedDisabled
  __resetHookConfigCacheForTests()
  vi.restoreAllMocks()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('runHooks — zero-overhead', () => {
  it('no config file → 100 PreToolUse calls → zero spawns', async () => {
    const spy = vi.spyOn(child_process, 'spawn')
    for (let i = 0; i < 100; i++) {
      const o = await runHooks('PreToolUse', 'sql_exec', preToolPayload(`sess-${i}`), {
        sessionId: `sess-${i}`,
      })
      expect(o.invoked).toBe(0)
      expect(o.events).toEqual([])
      expect(o.decision).toBeNull()
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('OPENHIVE_HOOKS_DISABLED=1 skips config entirely', async () => {
    const script = mkScript('x.sh', '#!/bin/sh\nexit 0\n')
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "*"\n      command: "${script}"\n`)
    process.env.OPENHIVE_HOOKS_DISABLED = '1'
    __resetHookConfigCacheForTests()
    const spy = vi.spyOn(child_process, 'spawn')
    const o = await runHooks('PreToolUse', 'sql_exec', preToolPayload(), {
      sessionId: 'sess-1',
    })
    expect(o.invoked).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('runHooks — PreToolUse block path', () => {
  it('exit 2 → decision=block + reason from stderr + hook.invoked event', async () => {
    const script = mkScript('guard.sh', '#!/bin/sh\necho "no sql allowed" 1>&2\nexit 2\n')
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "sql_*"\n      command: "${script}"\n`)
    const o = await runHooks('PreToolUse', 'sql_exec', preToolPayload(), {
      sessionId: 'sess-1',
    })
    expect(o.invoked).toBe(1)
    expect(o.decision).toBe('block')
    expect(o.reason).toBe('no sql allowed')
    expect(o.events).toHaveLength(1)
    expect(o.events[0]?.kind).toBe('hook.invoked')
    expect(o.events[0]?.data.exit_code).toBe(2)
    expect(o.events[0]?.data.decision).toBe('block')
  })

  it('JSON stdout decision=block is equivalent to exit 2', async () => {
    const script = mkScript(
      'jsonblock.sh',
      `#!/bin/sh\nprintf '{"decision":"block","reason":"policy"}'\n`,
    )
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "*"\n      command: "${script}"\n`)
    const o = await runHooks('PreToolUse', 'sql_exec', preToolPayload(), {
      sessionId: 'sess-1',
    })
    expect(o.decision).toBe('block')
    expect(o.reason).toBe('policy')
  })

  it('matcher mismatch → not invoked', async () => {
    const script = mkScript('mm.sh', '#!/bin/sh\nexit 2\n')
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "delegate_to"\n      command: "${script}"\n`)
    const o = await runHooks('PreToolUse', 'sql_exec', preToolPayload(), {
      sessionId: 'sess-1',
    })
    expect(o.invoked).toBe(0)
    expect(o.decision).toBeNull()
  })
})

describe('runHooks — SessionStart additionalContext', () => {
  it('captures and truncates to 8KB', async () => {
    // 10k "X" letters.
    const script = mkScript(
      'ctx.sh',
      `#!/bin/sh\nprintf '{"additionalContext":"%s"}' "$(printf 'X%.0s' $(seq 1 10000))"\n`,
    )
    writeConfig(`hooks:\n  SessionStart:\n    - matcher: "*"\n      command: "${script}"\n`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const o = await runHooks('SessionStart', 'acme', sessionStartPayload(), {
      sessionId: 'sess-1',
    })
    expect(o.additionalContext).not.toBeNull()
    expect(o.additionalContext?.length).toBe(8192)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncating'))
  })
})

describe('runHooks — chain control', () => {
  it('continue:false stops subsequent hooks', async () => {
    const a = mkScript('a.sh', `#!/bin/sh\nprintf '{"continue":false}'\n`)
    const b = mkScript('b.sh', '#!/bin/sh\necho b_ran 1>&2\nexit 0\n')
    writeConfig(
      `hooks:\n  SessionStart:\n    - matcher: "*"\n      command: "${a}"\n    - matcher: "*"\n      command: "${b}"\n`,
    )
    const o = await runHooks('SessionStart', 'acme', sessionStartPayload(), {
      sessionId: 'sess-1',
    })
    expect(o.invoked).toBe(1)
    expect(o.continueChain).toBe(false)
  })

  it('multiple additionalContext values join with blank line then cap', async () => {
    const a = mkScript('a2.sh', `#!/bin/sh\nprintf '{"additionalContext":"first"}'\n`)
    const b = mkScript('b2.sh', `#!/bin/sh\nprintf '{"additionalContext":"second"}'\n`)
    writeConfig(
      `hooks:\n  SessionStart:\n    - matcher: "*"\n      command: "${a}"\n    - matcher: "*"\n      command: "${b}"\n`,
    )
    const o = await runHooks('SessionStart', 'acme', sessionStartPayload(), {
      sessionId: 'sess-1',
    })
    expect(o.additionalContext).toBe('first\n\nsecond')
  })
})

describe('runHooks — Stop', () => {
  it('fires for completed status and records duration + matcher', async () => {
    const script = mkScript('notify.sh', '#!/bin/sh\ncat > /dev/null\nexit 0\n')
    writeConfig(`hooks:\n  Stop:\n    - matcher: "acme"\n      command: "${script}"\n`)
    const o = await runHooks('Stop', 'acme', stopPayload(), { sessionId: 'sess-1' })
    expect(o.invoked).toBe(1)
    expect(o.events).toHaveLength(1)
    expect(o.events[0]?.data.event_name).toBe('Stop')
    expect(o.events[0]?.data.matcher).toBe('acme')
    expect(typeof o.events[0]?.data.duration_ms).toBe('number')
  })
})
