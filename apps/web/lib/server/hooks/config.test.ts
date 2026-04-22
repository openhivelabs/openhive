import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetHookConfigCacheForTests, getHookConfig, hooksDisabled } from './config'

let tmpRoot: string
let savedDataDir: string | undefined
let savedDisabled: string | undefined

function writeConfig(body: string): string {
  const cfgPath = path.join(tmpRoot, 'config.yaml')
  fs.writeFileSync(cfgPath, body, 'utf8')
  return cfgPath
}

function mkScript(name: string): string {
  const p = path.join(tmpRoot, name)
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  try {
    fs.chmodSync(p, 0o755)
  } catch {
    /* ignore */
  }
  return p
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-hooks-cfg-'))
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
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks()
})

describe('getHookConfig', () => {
  it('returns empty config when file missing', () => {
    const cfg = getHookConfig()
    expect(cfg).toEqual({ SessionStart: [], PreToolUse: [], Stop: [] })
  })

  it('returns empty config when hooks key absent', () => {
    writeConfig('other: value\n')
    const cfg = getHookConfig()
    expect(cfg.PreToolUse).toEqual([])
  })

  it('parses valid entries', () => {
    const script = mkScript('g.sh')
    writeConfig(
      `hooks:\n  PreToolUse:\n    - matcher: "sql_*"\n      command: "${script}"\n      timeout: 5000\n`,
    )
    const cfg = getHookConfig()
    expect(cfg.PreToolUse).toHaveLength(1)
    expect(cfg.PreToolUse[0]?.matcher).toBe('sql_*')
    expect(cfg.PreToolUse[0]?.command).toBe(script)
    expect(cfg.PreToolUse[0]?.timeout).toBe(5000)
  })

  it('treats small timeout values as seconds', () => {
    const script = mkScript('g2.sh')
    writeConfig(
      `hooks:\n  PreToolUse:\n    - matcher: "*"\n      command: "${script}"\n      timeout: 10\n`,
    )
    const cfg = getHookConfig()
    expect(cfg.PreToolUse[0]?.timeout).toBe(10_000)
  })

  it('drops entries with non-absolute command paths', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "*"\n      command: "relative.sh"\n`)
    const cfg = getHookConfig()
    expect(cfg.PreToolUse).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('drops entries pointing at non-executable files', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const nonExec = path.join(tmpRoot, 'plain.txt')
    fs.writeFileSync(nonExec, 'hi', { mode: 0o644 })
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "*"\n      command: "${nonExec}"\n`)
    const cfg = getHookConfig()
    expect(cfg.PreToolUse).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('warns on unknown event names but keeps siblings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const script = mkScript('g3.sh')
    writeConfig(
      `hooks:\n  SessionStart:\n    - matcher: "*"\n      command: "${script}"\n  NotAnEvent:\n    - matcher: "*"\n      command: "${script}"\n`,
    )
    const cfg = getHookConfig()
    expect(cfg.SessionStart).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown event'))
  })

  it('caches parsed config until mtime changes', () => {
    const script = mkScript('g4.sh')
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "foo"\n      command: "${script}"\n`)
    const first = getHookConfig()
    const second = getHookConfig()
    // Same object reference when mtime unchanged.
    expect(second).toBe(first)
  })

  it('reparses when mtime changes', async () => {
    const script = mkScript('g5.sh')
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "foo"\n      command: "${script}"\n`)
    const first = getHookConfig()
    // Wait a tick and bump mtime explicitly.
    await new Promise((r) => setTimeout(r, 10))
    const later = Date.now() / 1000 + 5
    fs.utimesSync(path.join(tmpRoot, 'config.yaml'), later, later)
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "bar"\n      command: "${script}"\n`)
    const second = getHookConfig()
    expect(second).not.toBe(first)
    expect(second.PreToolUse[0]?.matcher).toBe('bar')
  })

  it('returns empty config when OPENHIVE_HOOKS_DISABLED=1', () => {
    const script = mkScript('g6.sh')
    writeConfig(`hooks:\n  PreToolUse:\n    - matcher: "*"\n      command: "${script}"\n`)
    process.env.OPENHIVE_HOOKS_DISABLED = '1'
    expect(hooksDisabled()).toBe(true)
    const cfg = getHookConfig()
    expect(cfg.PreToolUse).toEqual([])
  })
})
