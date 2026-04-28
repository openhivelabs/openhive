/**
 * Team file browser helpers. Ports apps/server/openhive/api/files.py logic
 * (read-only, path-traversal safe).
 */

import fs from 'node:fs'
import path from 'node:path'
import { teamDir } from './paths'
import { resolveTeamSlugs } from './companies'

interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
  path: string
}

export class FilesError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

function teamRoot(teamId: string): string {
  const resolved = resolveTeamSlugs(teamId)
  if (!resolved) throw new FilesError(404, `team not found: ${teamId}`)
  return teamDir(resolved.companySlug, resolved.teamSlug)
}

function safeResolve(root: string, rel: string): string {
  const resolved = path.resolve(root, rel)
  const rootAbs = path.resolve(root)
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    throw new FilesError(400, 'path outside team root')
  }
  return resolved
}

function toEntry(abs: string, root: string): FileEntry {
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return { name: path.basename(abs), type: 'file', size: 0, mtime: 0, path: '' }
  }
  const rel = abs === root ? '' : path.relative(root, abs)
  return {
    name: path.basename(abs),
    type: stat.isDirectory() ? 'dir' : 'file',
    size: stat.isFile() ? stat.size : 0,
    mtime: Math.trunc(stat.mtimeMs),
    path: rel,
  }
}

interface ListResult {
  path: string
  entries: FileEntry[]
}

export function listFiles(teamId: string, rel: string): ListResult {
  const root = teamRoot(teamId)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { path: '', entries: [] }
  }
  const target = rel ? safeResolve(root, rel) : root
  if (!fs.existsSync(target)) {
    throw new FilesError(404, 'path not found')
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new FilesError(400, 'not a directory')
  }
  const names = fs.readdirSync(target)
  const entries = names
    .map((n) => toEntry(path.join(target, n), root))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1
    })
  return {
    path: target === root ? '' : path.relative(root, target),
    entries,
  }
}

interface ReadResult {
  path: string
  size: number
  content: string | null
  binary: boolean
  reason?: string
}

export function readFile(teamId: string, rel: string): ReadResult {
  const root = teamRoot(teamId)
  const target = safeResolve(root, rel)
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new FilesError(404, 'not a file')
  }
  const size = fs.statSync(target).size
  if (size > 1_000_000) {
    return { path: rel, size, content: null, binary: true, reason: 'too large' }
  }
  try {
    const buf = fs.readFileSync(target)
    // Heuristic: consider file binary if it contains a NUL byte.
    if (buf.indexOf(0) !== -1) {
      return { path: rel, size, content: null, binary: true, reason: 'binary' }
    }
    return { path: rel, size, content: buf.toString('utf8'), binary: false }
  } catch {
    return { path: rel, size, content: null, binary: true, reason: 'binary' }
  }
}
