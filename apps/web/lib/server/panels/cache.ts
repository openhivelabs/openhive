/**
 * panel_cache — FS-only. One JSON file per panel under
 *   ~/.openhive/cache/panels/{panel_id}.json
 *
 * Scheduler writes here on successful/failed refresh; frontend reads via the
 * panel data endpoints. On failure we preserve stale `data_json` alongside the
 * `error` so the UI can show last-good data with an error indicator.
 */

import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../paths'

export interface CacheRow {
  panel_id: string
  team_id: string
  data: unknown
  error: string | null
  fetched_at: number
  duration_ms: number | null
}

interface Stored {
  panel_id: string
  team_id: string
  data_json: string | null
  error: string | null
  fetched_at: number
  duration_ms: number | null
}

function cacheRoot(): string {
  const dir = path.join(dataDir(), 'cache', 'panels')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function safeName(panelId: string): string {
  return panelId.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function pathFor(panelId: string): string {
  return path.join(cacheRoot(), `${safeName(panelId)}.json`)
}

function readStored(panelId: string): Stored | null {
  const p = pathFor(panelId)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Stored
  } catch {
    return null
  }
}

function writeStored(panelId: string, value: Stored): void {
  const p = pathFor(panelId)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

export function upsertSuccess(input: {
  panelId: string
  teamId: string
  data: unknown
  durationMs: number
}): void {
  writeStored(input.panelId, {
    panel_id: input.panelId,
    team_id: input.teamId,
    data_json: JSON.stringify(input.data),
    error: null,
    fetched_at: Date.now(),
    duration_ms: input.durationMs,
  })
}

export function upsertError(input: {
  panelId: string
  teamId: string
  error: string
  durationMs: number
}): void {
  const prior = readStored(input.panelId)
  writeStored(input.panelId, {
    panel_id: input.panelId,
    team_id: input.teamId,
    // Keep stale data so UI can show last-good alongside the error.
    data_json: prior?.data_json ?? null,
    error: input.error,
    fetched_at: Date.now(),
    duration_ms: input.durationMs,
  })
}

export function get(panelId: string): CacheRow | null {
  const s = readStored(panelId)
  if (!s) return null
  return {
    panel_id: s.panel_id,
    team_id: s.team_id,
    data: s.data_json ? JSON.parse(s.data_json) : null,
    error: s.error,
    fetched_at: s.fetched_at,
    duration_ms: s.duration_ms,
  }
}

export function deleteCache(panelId: string): void {
  const p = pathFor(panelId)
  if (fs.existsSync(p)) { try { fs.unlinkSync(p) } catch { /* ignore */ } }
}

export function deleteForTeam(teamId: string): void {
  const root = cacheRoot()
  for (const entry of fs.readdirSync(root)) {
    if (!entry.endsWith('.json')) continue
    const s = readStored(entry.replace(/\.json$/, ''))
    if (s?.team_id === teamId) {
      try { fs.unlinkSync(path.join(root, entry)) } catch { /* ignore */ }
    }
  }
}
