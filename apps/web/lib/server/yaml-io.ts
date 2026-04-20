/**
 * Shared YAML read/write with mtime cache. Ports the private helpers in
 * apps/server/openhive/persistence/companies.py — caching the parsed YAML
 * avoids reparsing the same org-chart file on every dashboard/canvas render.
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

interface CacheEntry {
  mtime: number
  data: Record<string, unknown>
}

const globalForCache = globalThis as unknown as {
  __openhive_yaml_cache?: Map<string, CacheEntry>
}

function cache(): Map<string, CacheEntry> {
  if (!globalForCache.__openhive_yaml_cache) {
    globalForCache.__openhive_yaml_cache = new Map()
  }
  return globalForCache.__openhive_yaml_cache
}

export function readYamlCached(file: string): Record<string, unknown> | null {
  const c = cache()
  let mtime: number
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    c.delete(file)
    return null
  }
  const hit = c.get(file)
  if (hit && hit.mtime === mtime) return hit.data
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  c.set(file, { mtime, data })
  return data
}

export function writeYaml(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = yaml.dump(data, { noRefs: true, sortKeys: false })
  fs.writeFileSync(file, body, 'utf8')
  try {
    cache().set(file, {
      mtime: fs.statSync(file).mtimeMs,
      data:
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {},
    })
  } catch {
    /* ignore — not critical if the stat fails */
  }
}

export function invalidateCachePrefix(prefix: string): void {
  const c = cache()
  for (const key of c.keys()) {
    if (key.startsWith(prefix)) c.delete(key)
  }
}
