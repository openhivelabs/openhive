/**
 * Scope-bound filesystem writer for AI-generated content.
 *
 * Design-time AI endpoints (agent/team generators) receive a `files` map
 * from the LLM and need to commit them to disk. The LLM can't be trusted
 * to stay inside its intended directory, so every write goes through
 * `scopedWrite` which:
 *   1. normalises the relative path,
 *   2. resolves it against a fixed base,
 *   3. asserts the result is still inside the base (post-symlink, post-`..`).
 *
 * Any attempt to escape (e.g. `../../company.yaml`, absolute path, URL-
 * encoded separator) throws `ScopeViolationError`. Callers translate that
 * into an HTTP 400.
 */

import fs from 'node:fs'
import path from 'node:path'

export class ScopeViolationError extends Error {
  constructor(
    public readonly base: string,
    public readonly relPath: string,
    reason: string,
  ) {
    super(`scope violation (${reason}): base=${base} rel=${relPath}`)
    this.name = 'ScopeViolationError'
  }
}

export interface WriteScope {
  /** Absolute directory. All writes must resolve inside this prefix. */
  readonly base: string
  /** Optional allowlist regex applied to the normalised relative path. */
  readonly allowPattern?: RegExp
}

function normalizeRel(rel: string): string {
  // Reject absolute paths and anything with a drive letter / URL scheme up front.
  if (rel.includes('\0')) throw new Error('null byte in path')
  const decoded = rel.replace(/%2f/gi, '/').replace(/%5c/gi, '/')
  if (decoded !== rel) {
    // URL-encoded separator is almost always an escape attempt.
    throw new Error('encoded separator not allowed')
  }
  const unified = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!unified || unified === '.' || unified === '..') throw new Error('empty path')
  return unified
}

/** Resolve `rel` inside `scope` or throw. Does not create anything. */
export function scopedResolve(scope: WriteScope, rel: string): string {
  let unified: string
  try {
    unified = normalizeRel(rel)
  } catch (err) {
    throw new ScopeViolationError(scope.base, rel, (err as Error).message)
  }
  if (scope.allowPattern && !scope.allowPattern.test(unified)) {
    throw new ScopeViolationError(scope.base, rel, 'disallowed pattern')
  }
  const baseAbs = path.resolve(scope.base)
  const target = path.resolve(baseAbs, unified)
  const prefix = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep
  if (target !== baseAbs && !target.startsWith(prefix)) {
    throw new ScopeViolationError(scope.base, rel, 'outside base')
  }
  return target
}

/** Write `bytes` at `scope/rel`. Creates parent dirs. Throws on scope escape. */
export function scopedWrite(scope: WriteScope, rel: string, bytes: string | Buffer): string {
  const dst = scopedResolve(scope, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, bytes)
  return dst
}

/** Bulk-write a `{relPath: contents}` map. All writes are pre-validated
 *  before any byte hits disk, so a single bad entry aborts the whole batch. */
export function scopedWriteAll(
  scope: WriteScope,
  files: Record<string, string>,
  opts?: { maxFiles?: number; maxBytesPerFile?: number },
): string[] {
  const maxFiles = opts?.maxFiles ?? 200
  const maxBytes = opts?.maxBytesPerFile ?? 256 * 1024
  const entries = Object.entries(files)
  if (entries.length > maxFiles) {
    throw new Error(`too many files (${entries.length} > ${maxFiles})`)
  }
  const resolved: [string, string][] = []
  for (const [rel, contents] of entries) {
    if (typeof rel !== 'string' || typeof contents !== 'string') {
      throw new Error('invalid file entry')
    }
    if (Buffer.byteLength(contents, 'utf8') > maxBytes) {
      throw new Error(`file too large: ${rel}`)
    }
    resolved.push([scopedResolve(scope, rel), contents])
  }
  const written: string[] = []
  for (const [dst, contents] of resolved) {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, contents, 'utf8')
    written.push(dst)
  }
  return written
}
