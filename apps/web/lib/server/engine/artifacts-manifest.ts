/**
 * Session artifact manifest renderer.
 *
 * Injected into the Lead's system prompt every turn (after the first artifact
 * exists) so the Lead has a passive inventory of what children have produced
 * across the entire session — not just what's in the last tool_result.
 *
 * Paired with <delegation-artifacts> block appended to each delegation's
 * tool_result content (see session.ts runDelegation). Two places, one rule:
 * the Lead must cite relevant artifacts in its final response.
 */

import type { ArtifactRecord } from '../artifacts'
import { sessionArtifactDir } from '../sessions'
import path from 'node:path'

export interface ManifestEntry {
  uri: string
  producer: string
  createdAt: number
  filename: string
}

function toUri(sessionId: string, absPath: string): string {
  const root = sessionArtifactDir(sessionId)
  const rel = path.relative(root, absPath).split(path.sep).join('/')
  return `artifact://session/${sessionId}/artifacts/${rel}`
}

export function toManifestEntry(
  rec: ArtifactRecord,
  sessionId: string,
): ManifestEntry {
  return {
    uri: toUri(sessionId, rec.path),
    producer: rec.skill_name ?? 'agent',
    createdAt: rec.created_at,
    filename: rec.filename,
  }
}

/**
 * Block appended to a delegation's tool_result content when the child produced
 * artifacts. Keeps the file paths inside the LLM-visible channel (tool_result
 * body), not just in event metadata where the LLM never looks.
 */
export function renderDelegationArtifacts(paths: string[]): string {
  if (!paths || paths.length === 0) return ''
  return [
    '',
    '<delegation-artifacts>',
    ...paths.map((p) => `- ${p}`),
    '</delegation-artifacts>',
  ].join('\n')
}

export function appendArtifactBlock(body: string, paths: string[] | undefined): string {
  if (!paths || paths.length === 0) return body
  return `${body}${renderDelegationArtifacts(paths)}`
}

export function renderSessionArtifacts(entries: ManifestEntry[]): string {
  if (entries.length === 0) return ''
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt)
  const lines = [
    '<session-artifacts>',
    'Artifacts produced so far in this session (by any agent at any depth):',
    ...sorted.map(
      (e) =>
        `- ${e.uri} (${e.filename}, produced by ${e.producer} at ${new Date(e.createdAt).toISOString()})`,
    ),
    '',
    "When you write your final response, you MUST cite any of these artifacts that are relevant to the user's request as markdown links, e.g. `[report.pdf](artifact://session/.../report.pdf)`. The UI renders these as download/preview chips. NEVER let a produced artifact silently disappear from your final answer.",
    '</session-artifacts>',
    '',
  ]
  return lines.join('\n')
}
