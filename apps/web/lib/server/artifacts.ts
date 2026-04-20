/**
 * Artifact metadata store. Ports apps/server/openhive/persistence/artifacts.py.
 * Reads/writes the same `artifacts` table as the Python side.
 */

import path from 'node:path'
import crypto from 'node:crypto'
import { artifactsRoot } from './paths'
import { getDb } from './db'

export interface ArtifactRecord {
  id: string
  run_id: string
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

export function artifactDirFor(
  companySlug: string | null,
  teamSlug: string | null,
  runId: string,
): string {
  return path.join(
    artifactsRoot(),
    companySlug ?? '_orphan',
    teamSlug ?? '_orphan',
    runId,
  )
}

function newId(): string {
  return `art_${crypto.randomBytes(6).toString('hex')}`
}

export interface RecordInput {
  run_id: string
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

export function recordArtifact(input: RecordInput): ArtifactRecord {
  const id = newId()
  getDb()
    .prepare(
      `INSERT INTO artifacts
         (id, run_id, team_id, company_slug, team_slug,
          skill_name, filename, path, mime, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.run_id,
      input.team_id,
      input.company_slug,
      input.team_slug,
      input.skill_name,
      input.filename,
      input.path,
      input.mime,
      input.size,
      input.created_at_ms,
    )
  return {
    id,
    run_id: input.run_id,
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
}

export function listForTeam(teamId: string): ArtifactRecord[] {
  return getDb()
    .prepare(
      'SELECT * FROM artifacts WHERE team_id = ? ORDER BY created_at DESC',
    )
    .all(teamId) as ArtifactRecord[]
}

export function listForRun(runId: string): ArtifactRecord[] {
  return getDb()
    .prepare(
      'SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC',
    )
    .all(runId) as ArtifactRecord[]
}

export function getArtifact(id: string): ArtifactRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM artifacts WHERE id = ?')
    .get(id) as ArtifactRecord | undefined
  return row ?? null
}
