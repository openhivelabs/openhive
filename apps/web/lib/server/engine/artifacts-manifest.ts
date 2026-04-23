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
import { listForSession } from '../artifacts'
import { sessionArtifactDir } from '../sessions'
import { parseArtifactUri } from '../sessions/artifacts'
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

/**
 * Set of canonical `artifact://` URIs currently on disk for the session.
 * Used by the post-processor to strip hallucinated artifact links from
 * the Lead's final text before it reaches the UI.
 */
export function getRealArtifactUriSet(sessionId: string): Set<string> {
  const root = sessionArtifactDir(sessionId)
  const out = new Set<string>()
  for (const r of listForSession(sessionId)) {
    const rel = path.relative(root, r.path).split(path.sep).join('/')
    out.add(`artifact://session/${sessionId}/artifacts/${rel}`)
  }
  return out
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
 * Validate a list of candidate "artifact paths" (as extracted by
 * result-cap's regex scanner) against the session's authoritative
 * artifact index. Returns only paths that correspond to REAL files
 * recorded via `recordArtifact()` by a skill run.
 *
 * This is the stability backstop against hallucinated URIs. Sub-agents
 * with no file-producing skills attached sometimes invent plausible-
 * looking paths like "artifact://session/report.pdf" in their text
 * response without actually producing anything — those must never be
 * forwarded to the Lead or the user.
 *
 * Matching is permissive on input form (absolute path / artifact://
 * URI / tilde-home / bare filename) but strict on destination — the
 * candidate must resolve to an ArtifactRecord of THIS session.
 *
 * Returns canonical `artifact://session/{sid}/artifacts/{rel}` URIs
 * (sorted by record.created_at) so downstream consumers always see the
 * same shape regardless of how the sub-agent wrote the path.
 */
export function filterRealArtifactPaths(
  sessionId: string,
  candidates: string[] | undefined,
): string[] {
  if (!candidates || candidates.length === 0) return []
  const records = listForSession(sessionId)
  if (records.length === 0) return []
  const byAbs = new Map<string, ArtifactRecord>()
  const byFilename = new Map<string, ArtifactRecord>()
  for (const r of records) {
    byAbs.set(r.path, r)
    // Later record wins ties — callers should usually have unique names anyway.
    byFilename.set(r.filename, r)
  }
  const root = sessionArtifactDir(sessionId)
  const homeTilde = /^~\//
  const out: ArtifactRecord[] = []
  const seen = new Set<string>()
  for (const raw of candidates) {
    const candidate = raw.trim()
    if (!candidate) continue

    // artifact:// URI — must parse, must belong to this session, must exist.
    if (candidate.startsWith('artifact://')) {
      const parsed = parseArtifactUri(candidate)
      if (!parsed || parsed.sessionId !== sessionId) continue
      const abs = path.resolve(path.join(root, ...parsed.relativePath.split('/')))
      const rec = byAbs.get(abs)
      if (rec && !seen.has(rec.id)) {
        out.push(rec)
        seen.add(rec.id)
      }
      continue
    }

    // Tilde-home form: normalise to absolute under sessions dir.
    if (homeTilde.test(candidate)) {
      const expanded = candidate.replace(homeTilde, `${process.env.HOME ?? ''}/`)
      const rec = byAbs.get(expanded)
      if (rec && !seen.has(rec.id)) {
        out.push(rec)
        seen.add(rec.id)
      }
      continue
    }

    // Absolute path — direct lookup.
    if (candidate.startsWith('/')) {
      const rec = byAbs.get(candidate)
      if (rec && !seen.has(rec.id)) {
        out.push(rec)
        seen.add(rec.id)
      }
      continue
    }

    // Bare filename fallback — only match if a unique record has this basename.
    const basename = path.posix.basename(candidate)
    const rec = byFilename.get(basename)
    if (rec && !seen.has(rec.id)) {
      out.push(rec)
      seen.add(rec.id)
    }
  }
  out.sort((a, b) => a.created_at - b.created_at)
  return out.map((r) => `artifact://session/${sessionId}/artifacts/${path.relative(root, r.path).split(path.sep).join('/')}`)
}

/**
 * Block appended to a delegation's tool_result content when the child
 * produced artifacts that were recorded in the session index. Only REAL
 * artifacts appear (see filterRealArtifactPaths).
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

export function appendArtifactBlock(
  body: string,
  paths: string[] | undefined,
  sessionId?: string,
): string {
  // Validate against the session's artifact index when we have one — a
  // sub-agent can only cite files it actually produced.
  const real = sessionId ? filterRealArtifactPaths(sessionId, paths) : paths ?? []
  if (real.length === 0) return body
  return `${body}${renderDelegationArtifacts(real)}`
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
