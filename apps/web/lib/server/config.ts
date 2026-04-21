/**
 * Server-side config — counterpart to apps/server/openhive/config.py.
 *
 * Reads env + defaults. Keeps the same data-dir semantics so the TS backend
 * and the legacy Python server read/write the same ~/.openhive/ tree during
 * migration.
 */

import { homedir } from 'node:os'
import path from 'node:path'

export interface ServerSettings {
  host: string
  port: number
  dataDir: string
  encryptionKey: string
  corsOrigins: string[]
  maxConcurrentRuns: number
  schedulerTickSeconds: number
}

let cached: ServerSettings | null = null

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

export function getSettings(): ServerSettings {
  if (cached) return cached
  const dataDir =
    process.env.OPENHIVE_DATA_DIR ?? path.join(homedir(), '.openhive')
  const corsRaw =
    process.env.OPENHIVE_CORS_ORIGINS ??
    'http://localhost:4483,http://127.0.0.1:4483'
  cached = {
    host: process.env.OPENHIVE_HOST ?? '127.0.0.1',
    port: parseIntEnv('OPENHIVE_PORT', 4483),
    dataDir,
    encryptionKey: process.env.OPENHIVE_ENCRYPTION_KEY ?? '',
    corsOrigins: corsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxConcurrentRuns: parseIntEnv('OPENHIVE_MAX_CONCURRENT_RUNS', 3),
    schedulerTickSeconds: parseIntEnv('OPENHIVE_SCHEDULER_TICK_SECONDS', 10),
  }
  return cached
}
