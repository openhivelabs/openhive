/**
 * Unit tests for A3 — `artifact://` URI + path resolver + `read_artifact`
 * tool. Covers cases A–K from spec §Task 4.2, including the prefix-match
 * bypass (case K) that only the `+ path.sep` guard catches.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Pin dataDir BEFORE any module that resolves paths through config is
// imported. `getSettings()` caches on first call, so this has to land
// before the imports below.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-a3-'))
process.env.OPENHIVE_DATA_DIR = TMP_ROOT

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as artifactsStore from '../artifacts'
import { sessionArtifactDir, sessionDir } from '../sessions'
import {
  ARTIFACT_READ_MAX_CHARS,
  buildArtifactUri,
  isTextMime,
  parseArtifactUri,
  readArtifactTool,
  resolveArtifactPath,
  resolveArtifactUri,
} from './artifacts'

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

/** Allocate a fresh session id and pre-create its artifact dir. */
function mkSession(): string {
  const id = `sess-${Math.random().toString(36).slice(2, 10)}`
  fs.mkdirSync(sessionArtifactDir(id), { recursive: true })
  fs.mkdirSync(sessionDir(id), { recursive: true })
  return id
}

/** Write a file under the session artifact dir and return its absolute path. */
function writeFile(sessionId: string, relPath: string, body: string): string {
  const abs = path.join(sessionArtifactDir(sessionId), relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body, 'utf8')
  return abs
}

/** Seed an artifact record so `listForSession` returns a match. */
function seedRecord(sessionId: string, absPath: string, mime: string): void {
  artifactsStore.recordArtifact({
    session_id: sessionId,
    team_id: 'team-test',
    company_slug: null,
    team_slug: null,
    skill_name: null,
    filename: path.basename(absPath),
    path: absPath,
    mime,
    size: fs.statSync(absPath).size,
    created_at_ms: Date.now(),
  })
}

describe('isTextMime', () => {
  it('accepts text/* and common text-ish application/* mimes', () => {
    expect(isTextMime('text/plain')).toBe(true)
    expect(isTextMime('text/csv')).toBe(true)
    expect(isTextMime('application/json')).toBe(true)
    expect(isTextMime('application/yaml')).toBe(true)
    expect(isTextMime('application/x-sh')).toBe(true)
    expect(isTextMime('application/sql')).toBe(true)
  })
  it('rejects binary mimes', () => {
    expect(isTextMime('application/pdf')).toBe(false)
    expect(isTextMime('image/png')).toBe(false)
    expect(
      isTextMime('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    ).toBe(false)
  })
  it('null mime rejected', () => {
    expect(isTextMime(null)).toBe(false)
  })
})

describe('URI round-trip', () => {
  it('A: buildArtifactUri → parseArtifactUri preserves session + relative path', () => {
    const sid = mkSession()
    const abs = writeFile(sid, 'sub/report.csv', 'col\n1\n')
    const uri = buildArtifactUri(sid, abs)
    expect(uri).toBe(`artifact://session/${sid}/artifacts/sub/report.csv`)
    const parsed = parseArtifactUri(uri)
    expect(parsed).toEqual({ sessionId: sid, relativePath: 'sub/report.csv' })
  })
})

describe('resolveArtifactUri', () => {
  it('B: resolves a valid file under the session artifact dir', () => {
    const sid = mkSession()
    const abs = writeFile(sid, 'report.csv', 'x')
    const uri = buildArtifactUri(sid, abs)
    const r = resolveArtifactUri(uri, { callerSessionId: sid })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved.absPath).toBe(path.resolve(abs))
      expect(r.resolved.relativePath).toBe('report.csv')
      expect(r.resolved.sessionId).toBe(sid)
    }
  })

  it('C: traversal (..) is blocked', () => {
    const sid = mkSession()
    // Use the bare-path resolver so the traversal guard trips on a rel.
    const r = resolveArtifactPath('../../../etc/passwd', {
      callerSessionId: sid,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(['traversal', 'outside_root']).toContain(r.reason)
    }
  })

  it('D: absolute path outside root is blocked', () => {
    const sid = mkSession()
    const r = resolveArtifactPath('/etc/passwd', { callerSessionId: sid })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('outside_root')
  })

  it('E: cross-session URI is blocked (session_mismatch)', () => {
    const sidA = mkSession()
    const sidB = mkSession()
    const abs = writeFile(sidA, 'a.txt', 'hi')
    const uri = buildArtifactUri(sidA, abs)
    const r = resolveArtifactUri(uri, { callerSessionId: sidB })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('session_mismatch')
  })

  it('F: not_found for missing file', () => {
    const sid = mkSession()
    const r = resolveArtifactPath('ghost.txt', { callerSessionId: sid })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('K: prefix-match bypass is blocked (artifacts2/ not a child of artifacts/)', () => {
    const sid = mkSession()
    const root = sessionArtifactDir(sid)
    // Sibling directory with a name that `startsWith(root)` without the
    // path.sep guard. Drop a file in there and try to read it.
    const sibling = `${root}2`
    fs.mkdirSync(sibling, { recursive: true })
    const leakPath = path.join(sibling, 'leak.txt')
    fs.writeFileSync(leakPath, 'secret', 'utf8')
    const r = resolveArtifactPath(leakPath, { callerSessionId: sid })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('outside_root')
  })
})

describe('readArtifactTool', () => {
  // -------- G: text mode returns content untruncated --------
  it('G: mode=text returns content when within cap', async () => {
    const sid = mkSession()
    const abs = writeFile(sid, 'hello.txt', 'hello, world')
    seedRecord(sid, abs, 'text/plain')
    const tool = readArtifactTool(sid)
    const raw = await tool.handler({ path: 'hello.txt', mode: 'text' })
    const out = JSON.parse(String(raw))
    expect(out.ok).toBe(true)
    expect(out.content).toBe('hello, world')
    expect(out.truncated).toBe(false)
    expect(out.meta.mime).toBe('text/plain')
    expect(out.meta.uri).toBe(buildArtifactUri(sid, abs))
  })

  // -------- H: truncation at ARTIFACT_READ_MAX_CHARS --------
  it('H: truncates at ARTIFACT_READ_MAX_CHARS', async () => {
    const sid = mkSession()
    const body = 'y'.repeat(ARTIFACT_READ_MAX_CHARS + 500)
    const abs = writeFile(sid, 'big.txt', body)
    seedRecord(sid, abs, 'text/plain')
    const tool = readArtifactTool(sid)
    const raw = await tool.handler({ path: 'big.txt', mode: 'text' })
    const out = JSON.parse(String(raw))
    expect(out.ok).toBe(true)
    expect(out.truncated).toBe(true)
    expect(out.content.length).toBe(ARTIFACT_READ_MAX_CHARS)
    expect(out.truncated_at_chars).toBe(ARTIFACT_READ_MAX_CHARS)
  })

  // -------- I: binary mime rejected for text mode, allowed for meta --------
  it('I: binary mime rejects text mode, meta succeeds', async () => {
    const sid = mkSession()
    const abs = writeFile(sid, 'slides.pdf', '%PDF-1.4\n')
    seedRecord(sid, abs, 'application/pdf')
    const tool = readArtifactTool(sid)

    const textRaw = await tool.handler({ path: 'slides.pdf', mode: 'text' })
    const textOut = JSON.parse(String(textRaw))
    expect(textOut.ok).toBe(false)
    expect(String(textOut.error)).toContain('binary mime')

    const metaRaw = await tool.handler({ path: 'slides.pdf', mode: 'meta' })
    const metaOut = JSON.parse(String(metaRaw))
    expect(metaOut.ok).toBe(true)
    expect(metaOut.meta.mime).toBe('application/pdf')
  })

  // -------- J: meta mode falls back to stat when no record seeded --------
  it('J: meta mode works without a seeded record (stat-only metadata)', async () => {
    const sid = mkSession()
    const abs = writeFile(sid, 'loose.txt', 'no record here')
    const tool = readArtifactTool(sid)
    const raw = await tool.handler({ path: 'loose.txt', mode: 'meta' })
    const out = JSON.parse(String(raw))
    expect(out.ok).toBe(true)
    expect(out.meta.name).toBe('loose.txt')
    expect(out.meta.mime).toBeNull()
    expect(out.meta.size_bytes).toBe(fs.statSync(abs).size)
    // With mime=null, subsequent text-mode read must fail binary_mime.
    const textRaw = await tool.handler({ path: 'loose.txt', mode: 'text' })
    const textOut = JSON.parse(String(textRaw))
    expect(textOut.ok).toBe(false)
  })

  it('returns denied for cross-session URI via tool handler', async () => {
    const sidA = mkSession()
    const sidB = mkSession()
    const abs = writeFile(sidA, 'only-a.txt', 'x')
    seedRecord(sidA, abs, 'text/plain')
    const uri = buildArtifactUri(sidA, abs)
    const tool = readArtifactTool(sidB)
    const raw = await tool.handler({ path: uri, mode: 'text' })
    const out = JSON.parse(String(raw))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('session_mismatch')
  })

  it('empty path is rejected', async () => {
    const sid = mkSession()
    const tool = readArtifactTool(sid)
    const raw = await tool.handler({ path: '' })
    const out = JSON.parse(String(raw))
    expect(out.ok).toBe(false)
  })
})

// Keep a per-test reset hook so record files from one test don't bleed into
// `listForSession` assertions of another.
beforeEach(() => {
  // no-op; each test allocates its own session id via mkSession().
})
afterEach(() => {
  // Keep TMP_ROOT across tests (cleaned in afterAll) — session dirs are
  // namespaced by random id so cross-contamination isn't possible.
})
