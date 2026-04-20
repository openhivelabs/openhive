/**
 * panel_cache CRUD — last-known data for each bound block.
 * Ports apps/server/openhive/panels/cache.py.
 *
 * The scheduler refreshes bindings on a cadence and writes the result here.
 * The frontend reads via /api/panels/:id/data (or SSE). On failure, `error`
 * is populated and stale `data_json` is preserved so the UI can still show
 * last-good data alongside an error indicator.
 */

import { getDb } from '../db'

export interface CacheRow {
  panel_id: string
  team_id: string
  data: unknown
  error: string | null
  fetched_at: number
  duration_ms: number | null
}

interface RawRow {
  panel_id: string
  team_id: string
  data_json: string | null
  error: string | null
  fetched_at: number
  duration_ms: number | null
}

export function upsertSuccess(input: {
  panelId: string
  teamId: string
  data: unknown
  durationMs: number
}): void {
  const payload = JSON.stringify(input.data)
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO panel_cache (panel_id, team_id, data_json, error, fetched_at, duration_ms)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(panel_id) DO UPDATE SET
         team_id = excluded.team_id,
         data_json = excluded.data_json,
         error = NULL,
         fetched_at = excluded.fetched_at,
         duration_ms = excluded.duration_ms`,
    )
    .run(input.panelId, input.teamId, payload, now, input.durationMs)
}

export function upsertError(input: {
  panelId: string
  teamId: string
  error: string
  durationMs: number
}): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO panel_cache (panel_id, team_id, data_json, error, fetched_at, duration_ms)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(panel_id) DO UPDATE SET
         team_id = excluded.team_id,
         error = excluded.error,
         fetched_at = excluded.fetched_at,
         duration_ms = excluded.duration_ms`,
    )
    .run(input.panelId, input.teamId, input.error, now, input.durationMs)
}

export function get(panelId: string): CacheRow | null {
  const row = getDb()
    .prepare(
      `SELECT panel_id, team_id, data_json, error, fetched_at, duration_ms
         FROM panel_cache WHERE panel_id = ?`,
    )
    .get(panelId) as RawRow | undefined
  if (!row) return null
  return {
    panel_id: row.panel_id,
    team_id: row.team_id,
    data: row.data_json ? JSON.parse(row.data_json) : null,
    error: row.error,
    fetched_at: row.fetched_at,
    duration_ms: row.duration_ms,
  }
}

export function deleteCache(panelId: string): void {
  getDb().prepare('DELETE FROM panel_cache WHERE panel_id = ?').run(panelId)
}

export function deleteForTeam(teamId: string): void {
  getDb().prepare('DELETE FROM panel_cache WHERE team_id = ?').run(teamId)
}
