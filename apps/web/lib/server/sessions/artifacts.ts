/**
 * A3 — Artifact rehydration.
 *
 * URI scheme + path resolver + `read_artifact` tool. The record store
 * (mime / size / created_at / filename) lives in `../artifacts.ts`; this
 * module layers URI addressing and a read-through tool on top of it.
 *
 * URI form:  `artifact://session/{session_id}/artifacts/{relative_path}`
 *  - `{session_id}` matches `ArtifactRecord.session_id`.
 *  - `{relative_path}` is POSIX, relative to `sessionArtifactDir(session_id)`.
 *
 * Security: every resolution path runs an 8-stage guard. The `+ path.sep`
 * guard on `startsWith(root)` is load-bearing — without it
 * `/root/artifacts2/leak` would match `/root/artifacts`. See spec §Task 1.3.
 */

import fs from 'node:fs'
import path from 'node:path'

import * as artifactsStore from '../artifacts'
import { makeEvent } from '../events/schema'
import { sessionArtifactDir } from '../sessions'
import type { Tool } from '../tools/base'
import { enqueueEvent } from './event-writer'

/** Max chars returned by `read_artifact({mode: 'text'})`. */
export const ARTIFACT_READ_MAX_CHARS = (() => {
  const raw = process.env.OPENHIVE_ARTIFACT_READ_MAX_CHARS
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 50_000
})()

const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/x-sh',
  'application/csv',
]
const TEXT_MIME_EXACT = new Set<string>([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/x-sh',
  'application/csv',
  'application/sql',
])

export function isTextMime(mime: string | null): boolean {
  if (!mime) return false
  if (TEXT_MIME_EXACT.has(mime)) return true
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))
}

// ---------------- URI builder / parser ----------------

/** Build an `artifact://` URI for a file under the session's artifact dir.
 *  `absPath` must already be inside `sessionArtifactDir(sessionId)` — callers
 *  supply paths they just produced (e.g. registerSkillArtifacts), so we do
 *  not re-validate here. */
export function buildArtifactUri(sessionId: string, absPath: string): string {
  const root = sessionArtifactDir(sessionId)
  const rel = path.relative(root, absPath).split(path.sep).join('/')
  return `artifact://session/${sessionId}/artifacts/${rel}`
}

export interface ParsedArtifactUri {
  sessionId: string
  relativePath: string
}

export function parseArtifactUri(uri: string): ParsedArtifactUri | null {
  const m = uri.match(/^artifact:\/\/session\/([^/]+)\/artifacts\/(.+)$/)
  if (!m) return null
  const [, sessionId, relativePath] = m
  if (!sessionId || !relativePath) return null
  return { sessionId, relativePath }
}

// ---------------- Path resolver (security-critical) ----------------

export interface ResolvedArtifact {
  absPath: string
  sessionId: string
  relativePath: string
}

export type ResolveDenyReason =
  | 'invalid_uri'
  | 'session_mismatch'
  | 'traversal'
  | 'outside_root'
  | 'not_found'

export interface ResolveOpts {
  /** Caller's current session. URI session id must match. */
  callerSessionId: string
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedArtifact }
  | { ok: false; reason: ResolveDenyReason }

/**
 * Resolve an `artifact://` URI to an absolute file path. 8-stage guard:
 *
 *  1. parseArtifactUri → `invalid_uri`
 *  2. caller session id mismatch → `session_mismatch`
 *  3. `..` or absolute-looking relative path → `traversal`
 *  4. compute root = sessionArtifactDir(parsed.sessionId)
 *  5. compute abs = path.resolve(path.join(root, ...rel.split('/')))
 *  6. abs not under root (with `path.sep` guard) → `outside_root`
 *  7. existsSync + isFile → `not_found`
 *  8. pass
 */
export function resolveArtifactUri(uri: string, opts: ResolveOpts): ResolveResult {
  // (1)
  const parsed = parseArtifactUri(uri)
  if (!parsed) return { ok: false, reason: 'invalid_uri' }

  // (2)
  if (parsed.sessionId !== opts.callerSessionId) {
    return { ok: false, reason: 'session_mismatch' }
  }

  // (3) Positive traversal check: normalised POSIX form must equal original
  //     and must not start with `..`. Reject absolute-looking paths too.
  const rel = parsed.relativePath
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) {
    return { ok: false, reason: 'traversal' }
  }
  const normalised = path.posix.normalize(rel)
  if (normalised !== rel) return { ok: false, reason: 'traversal' }
  if (normalised.startsWith('..') || normalised.split('/').some((s) => s === '..')) {
    return { ok: false, reason: 'traversal' }
  }

  // (4)
  const root = sessionArtifactDir(parsed.sessionId)

  // (5)
  const abs = path.resolve(path.join(root, ...rel.split('/')))
  const rRoot = path.resolve(root)

  // (6) `+ path.sep` guard — without it, `/root/artifacts2/leak` would
  //     match `/root/artifacts`. Equality check covers abs === root (dir
  //     itself, which subsequently fails isFile).
  if (abs !== rRoot && !abs.startsWith(rRoot + path.sep)) {
    return { ok: false, reason: 'outside_root' }
  }

  // (7)
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return { ok: false, reason: 'not_found' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not_found' }

  // (8)
  return {
    ok: true,
    resolved: {
      absPath: abs,
      sessionId: parsed.sessionId,
      relativePath: rel,
    },
  }
}

/**
 * Accept either an `artifact://` URI or a bare path. Bare paths are
 * interpreted relative to the caller session's artifact dir; absolute
 * paths are accepted only if they already sit under that dir (lets the
 * LLM pass envelope paths back in verbatim).
 */
export function resolveArtifactPath(input: string, opts: ResolveOpts): ResolveResult {
  if (input.startsWith('artifact://')) return resolveArtifactUri(input, opts)

  if (path.isAbsolute(input)) {
    const root = sessionArtifactDir(opts.callerSessionId)
    const rAbs = path.resolve(input)
    const rRoot = path.resolve(root)
    if (rAbs !== rRoot && !rAbs.startsWith(rRoot + path.sep)) {
      return { ok: false, reason: 'outside_root' }
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(rAbs)
    } catch {
      return { ok: false, reason: 'not_found' }
    }
    if (!stat.isFile()) return { ok: false, reason: 'not_found' }
    const rel = path.relative(rRoot, rAbs).split(path.sep).join('/')
    return {
      ok: true,
      resolved: {
        absPath: rAbs,
        sessionId: opts.callerSessionId,
        relativePath: rel,
      },
    }
  }

  // Bare relative path → synthesise URI and route through the URI guard.
  const synth = `artifact://session/${opts.callerSessionId}/artifacts/${input}`
  return resolveArtifactUri(synth, opts)
}

// ---------------- Event emitters ----------------

export function emitArtifactRead(
  sessionId: string,
  relPath: string,
  mode: 'meta' | 'text',
  bytesReturned: number,
): void {
  const ev = makeEvent(
    'artifact.read',
    sessionId,
    { path: relPath, mode, bytes_returned: bytesReturned },
    { tool_name: 'read_artifact' },
  )
  enqueueEvent(sessionId, `${JSON.stringify(ev)}\n`)
}

export function emitArtifactReadDenied(
  sessionId: string,
  attemptedPath: string,
  reason: string,
): void {
  const ev = makeEvent(
    'artifact.read.denied',
    sessionId,
    { path: attemptedPath, reason },
    { tool_name: 'read_artifact' },
  )
  enqueueEvent(sessionId, `${JSON.stringify(ev)}\n`)
}

// ---------------- read_artifact tool ----------------

const BINARY_REASON = 'binary_mime'

export function readArtifactTool(sessionId: string): Tool {
  return {
    name: 'read_artifact',
    description:
      'Re-read an artifact (file produced earlier in this session) by its ' +
      "artifact:// URI or its relative path under this session's artifacts/ " +
      'directory. Default mode "meta" returns metadata only (cheap). Mode ' +
      '"text" returns the file contents up to a character limit; binary ' +
      'mimes (PDF, PPTX, images) are rejected — use a skill script to ' +
      'extract their content instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Either an artifact:// URI (e.g. ' +
            '"artifact://session/abc/artifacts/report.csv") or a path ' +
            "relative to this session's artifacts/ directory " +
            '(e.g. "report.csv").',
        },
        mode: {
          type: 'string',
          enum: ['meta', 'text'],
          description: 'meta (default): metadata only. text: file contents.',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const inputPath =
        typeof (args as { path?: unknown }).path === 'string'
          ? ((args as { path: string }).path as string)
          : ''
      const modeRaw = (args as { mode?: unknown }).mode
      const mode: 'meta' | 'text' = modeRaw === 'text' ? 'text' : 'meta'

      if (!inputPath) {
        emitArtifactReadDenied(sessionId, inputPath, 'invalid_uri')
        return JSON.stringify({ ok: false, error: 'denied: invalid_uri' })
      }

      const r = resolveArtifactPath(inputPath, { callerSessionId: sessionId })
      if (!r.ok) {
        emitArtifactReadDenied(sessionId, inputPath, r.reason)
        return JSON.stringify({ ok: false, error: `denied: ${r.reason}` })
      }
      const { absPath, relativePath } = r.resolved

      // Authoritative metadata from record store when available.
      const records = artifactsStore.listForSession(sessionId)
      const rec = records.find((x) => x.path === absPath) ?? null

      let stat: fs.Stats
      try {
        stat = fs.statSync(absPath)
      } catch {
        emitArtifactReadDenied(sessionId, inputPath, 'not_found')
        return JSON.stringify({ ok: false, error: 'denied: not_found' })
      }

      const meta = {
        name: rec?.filename ?? path.basename(absPath),
        path: relativePath,
        uri: buildArtifactUri(sessionId, absPath),
        mime: rec?.mime ?? null,
        size_bytes: rec?.size ?? stat.size,
        created_at: rec?.created_at ?? Math.floor(stat.mtimeMs),
        session_id: sessionId,
      }

      if (mode === 'meta') {
        emitArtifactRead(sessionId, relativePath, 'meta', 0)
        return JSON.stringify({ ok: true, meta })
      }

      // mode === 'text'
      if (!isTextMime(meta.mime)) {
        emitArtifactReadDenied(sessionId, inputPath, BINARY_REASON)
        return JSON.stringify({
          ok: false,
          meta,
          error: 'binary mime; use a skill script (extract_doc / inspect_doc) to read content.',
        })
      }
      let full: string
      try {
        full = fs.readFileSync(absPath, 'utf8')
      } catch (exc) {
        emitArtifactReadDenied(sessionId, inputPath, 'not_found')
        return JSON.stringify({
          ok: false,
          error: `read failed: ${exc instanceof Error ? exc.message : String(exc)}`,
        })
      }
      const truncated = full.length > ARTIFACT_READ_MAX_CHARS
      const content = truncated ? full.slice(0, ARTIFACT_READ_MAX_CHARS) : full
      emitArtifactRead(sessionId, relativePath, 'text', content.length)
      return JSON.stringify({
        ok: true,
        meta,
        content,
        truncated,
        truncated_at_chars: truncated ? ARTIFACT_READ_MAX_CHARS : null,
      })
    },
    hint: 'Reading artifact…',
  }
}
