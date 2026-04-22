/**
 * Hook config loader — reads `~/.openhive/config.yaml#hooks`, validates, caches
 * on globalThis (survives Vite HMR / tsx watch), invalidates on mtime change.
 *
 * Zero-config path: if the file is missing or `hooks:` is absent → returns
 * empty config and the engine never spawns anything. `OPENHIVE_HOOKS_DISABLED=1`
 * short-circuits before even statting the file.
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

import type { HookConfig, HookEntry, HookEventName } from './types'

/** Resolves the hook config path freshly on every call so tests that rotate
 *  `OPENHIVE_DATA_DIR` between cases aren't trapped by the `getSettings()`
 *  cache in `../config.ts`. Production code pays a path.join per read. */
function resolveConfigPath(): string {
  const dir = process.env.OPENHIVE_DATA_DIR ?? path.join(homedir(), '.openhive')
  return path.join(dir, 'config.yaml')
}

const KEY = Symbol.for('openhive.hooks.configCache')

interface Cache {
  mtimeMs: number
  config: HookConfig
  path: string
}

type GlobalShape = { [k: symbol]: Cache | undefined }

function g(): GlobalShape {
  return globalThis as unknown as GlobalShape
}

function emptyConfig(): HookConfig {
  return { SessionStart: [], PreToolUse: [], Stop: [] }
}

const DEFAULT_TIMEOUTS: Record<HookEventName, number> = {
  SessionStart: 30_000,
  PreToolUse: 10_000,
  Stop: 60_000,
}

const KNOWN_EVENTS: ReadonlySet<HookEventName> = new Set(['SessionStart', 'PreToolUse', 'Stop'])

function validateEntry(event: HookEventName, raw: unknown): HookEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[hooks] ${event}: entry is not an object, dropping`)
    return null
  }
  const obj = raw as Record<string, unknown>
  const matcher = typeof obj.matcher === 'string' && obj.matcher.length > 0 ? obj.matcher : '*'
  const command = typeof obj.command === 'string' ? obj.command : null
  if (!command) {
    console.warn(`[hooks] ${event}: entry missing \`command\`, dropping`)
    return null
  }
  if (!path.isAbsolute(command)) {
    console.warn(`[hooks] ${event}: command must be absolute path (got ${command}), dropping`)
    return null
  }
  try {
    fs.accessSync(command, fs.constants.X_OK)
  } catch {
    console.warn(`[hooks] ${event}: command not executable (${command}), dropping`)
    return null
  }
  const timeoutRaw = obj.timeout
  const timeout =
    typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? // Claude Code expresses timeout in seconds. If user writes a small int
        // (<1000) treat it as seconds; otherwise as ms. Lossy but pragmatic.
        timeoutRaw < 1000
        ? timeoutRaw * 1000
        : timeoutRaw
      : DEFAULT_TIMEOUTS[event]
  return { matcher, command, timeout }
}

function parseRaw(rawHooks: unknown): HookConfig {
  const out = emptyConfig()
  if (!rawHooks || typeof rawHooks !== 'object' || Array.isArray(rawHooks)) return out
  for (const [evName, entries] of Object.entries(rawHooks as Record<string, unknown>)) {
    if (!KNOWN_EVENTS.has(evName as HookEventName)) {
      console.warn(`[hooks] unknown event '${evName}', skipping (forward-compat)`)
      continue
    }
    if (!Array.isArray(entries)) {
      console.warn(`[hooks] ${evName}: expected list, dropping`)
      continue
    }
    const event = evName as HookEventName
    for (const raw of entries) {
      const entry = validateEntry(event, raw)
      if (entry) out[event].push(entry)
    }
  }
  return out
}

function readFromDisk(cfgPath: string): { mtimeMs: number; config: HookConfig } {
  let stat: fs.Stats
  try {
    stat = fs.statSync(cfgPath)
  } catch {
    return { mtimeMs: 0, config: emptyConfig() }
  }
  let text: string
  try {
    text = fs.readFileSync(cfgPath, 'utf8')
  } catch (exc) {
    console.warn(`[hooks] failed to read ${cfgPath}: ${(exc as Error).message}`)
    return { mtimeMs: stat.mtimeMs, config: emptyConfig() }
  }
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (exc) {
    console.warn(`[hooks] YAML parse error in ${cfgPath}: ${(exc as Error).message}`)
    return { mtimeMs: stat.mtimeMs, config: emptyConfig() }
  }
  const hooks =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).hooks
      : undefined
  return { mtimeMs: stat.mtimeMs, config: parseRaw(hooks) }
}

export function hooksDisabled(): boolean {
  return process.env.OPENHIVE_HOOKS_DISABLED === '1'
}

export function getHookConfig(): HookConfig {
  if (hooksDisabled()) return emptyConfig()
  const cfgPath = resolveConfigPath()
  const cache = g()[KEY]
  let currentMtime = 0
  try {
    currentMtime = fs.statSync(cfgPath).mtimeMs
  } catch {
    currentMtime = 0
  }
  if (cache && cache.path === cfgPath && cache.mtimeMs === currentMtime) {
    return cache.config
  }
  const fresh = readFromDisk(cfgPath)
  g()[KEY] = { mtimeMs: fresh.mtimeMs, config: fresh.config, path: cfgPath }
  return fresh.config
}

/** Test helper — drop the globalThis cache so a subsequent call rereads. */
export function __resetHookConfigCacheForTests(): void {
  delete g()[KEY]
}
