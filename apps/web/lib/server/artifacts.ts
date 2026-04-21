/**
 * Artifact metadata — stored as per-session JSON at
 * ~/.openhive/sessions/{session_id}/artifacts.json. The list is the source of
 * truth; the actual files sit in the sibling artifacts/ directory.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { sessionArtifactsIndexPath, sessionDir } from './sessions'
import { listSessions } from './sessions'

export interface ArtifactRecord {
  id: string
  session_id: string
  team_id: string
  company_slug: string | null
  team_slug: string | null
  skill_name: string | null
  filename: string
  path: string
  mime: string | null
  size: number | null
  created_at: number
}

export interface RecordInput {
  session_id: string
  team_id: string
  company_slug: string | null
  team_slug: string | null
  skill_name: string | null
  filename: string
  path: string
  mime: string
  size: number
  created_at_ms: number
}

function newId(): string {
  return `art_${crypto.randomBytes(6).toString('hex')}`
}

function readIndex(sessionId: string): ArtifactRecord[] {
  const p = sessionArtifactsIndexPath(sessionId)
  if (!fs.existsSync(p)) return []
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(data) ? (data as ArtifactRecord[]) : []
  } catch {
    return []
  }
}

function writeIndex(sessionId: string, records: ArtifactRecord[]): void {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true })
  const p = sessionArtifactsIndexPath(sessionId)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

export function recordArtifact(input: RecordInput): ArtifactRecord {
  const rec: ArtifactRecord = {
    id: newId(),
    session_id: input.session_id,
    team_id: input.team_id,
    company_slug: input.company_slug,
    team_slug: input.team_slug,
    skill_name: input.skill_name,
    filename: input.filename,
    path: input.path,
    mime: input.mime,
    size: input.size,
    created_at: input.created_at_ms,
  }
  const existing = readIndex(input.session_id)
  existing.push(rec)
  writeIndex(input.session_id, existing)
  return rec
}

export function listForSession(sessionId: string): ArtifactRecord[] {
  return readIndex(sessionId).sort((a, b) => a.created_at - b.created_at)
}

export function listForTeam(teamId: string): ArtifactRecord[] {
  // Walk every session that belongs to this team, merge their artifact
  // indexes, sort by creation time. At current scale this is instantaneous.
  const out: ArtifactRecord[] = []
  for (const meta of listSessions(10_000)) {
    if (meta.team_id !== teamId) continue
    for (const rec of readIndex(meta.id)) out.push(rec)
  }
  out.sort((a, b) => b.created_at - a.created_at)
  return out
}

export function getArtifact(id: string): ArtifactRecord | null {
  for (const meta of listSessions(10_000)) {
    for (const rec of readIndex(meta.id)) {
      if (rec.id === id) return rec
    }
  }
  return null
}
