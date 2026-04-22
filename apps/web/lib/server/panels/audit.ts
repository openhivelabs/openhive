/**
 * Panel action audit log — append-only JSON lines per team.
 *
 *   companies/{c}/teams/{t}/audit.jsonl
 *
 * One line per executed panel action. Written best-effort; never throws back
 * into the caller — an audit failure must not block the user's write. Used by
 * future forensics / "who changed this" UI.
 *
 * Intentionally separate from `events.jsonl` (session-scoped engine events).
 * Audit is team-wide and has no session context.
 */

import fs from 'node:fs'
import path from 'node:path'
import { teamDir } from '../paths'

export interface PanelActionAuditEntry {
  ts: number
  panel_id: string
  action_id: string
  action_kind: string
  target_kind: string
  values_sha: string      // SHA of JSON-stringified values (no raw data)
  rows_changed?: number
  result_summary?: string // first 200 chars of JSON-stringified result
  error?: string
}

function auditPath(companySlug: string, teamSlug: string): string {
  return path.join(teamDir(companySlug, teamSlug), 'audit.jsonl')
}

function sha(input: string): string {
  // Cheap FNV-1a 64-ish → hex. We never need cryptographic strength here;
  // the point is stable identity for "did the same input run twice".
  let h1 = 2166136261 >>> 0
  let h2 = 2166136261 >>> 0
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ (c * 7 + 11), 16777619)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

export function logPanelAction(
  companySlug: string,
  teamSlug: string,
  entry: Omit<PanelActionAuditEntry, 'ts' | 'values_sha'> & {
    values: Record<string, unknown>
  },
): void {
  try {
    const p = auditPath(companySlug, teamSlug)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const { values, ...rest } = entry
    const line = JSON.stringify({
      ts: Date.now(),
      values_sha: sha(JSON.stringify(values)),
      ...rest,
    })
    fs.appendFileSync(p, `${line}\n`)
  } catch {
    /* never fail the write path over audit */
  }
}
