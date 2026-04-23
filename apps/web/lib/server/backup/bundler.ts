import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import Database from 'better-sqlite3'
import * as tar from 'tar'
import {
  artifactsRoot,
  companiesRoot,
  dataDir,
  dbPath,
  globalConfigPath,
  mcpConfigPath,
  sessionsRoot,
  skillsRoot,
} from '../paths'

const EXCLUDED_FILE_NAMES = new Set([
  'encryption.key',
  'credentials.enc.json',
  'oauth.enc.json',
  '.DS_Store',
  '.legacy-db-migrated',
])

const EXCLUDED_SEGMENTS = new Set(['cache', 'fonts', 'backups'])

function isExcluded(relFromDataDir: string): boolean {
  const base = path.basename(relFromDataDir)
  if (EXCLUDED_FILE_NAMES.has(base)) return true
  const segments = relFromDataDir.split(path.sep)
  for (const seg of segments) {
    if (EXCLUDED_SEGMENTS.has(seg)) return true
  }
  return false
}

function listIncludeRoots(): Array<{ abs: string; rel: string }> {
  const root = dataDir()
  const candidates: Array<{ abs: string; rel: string }> = []
  const topLevel = [
    dbPath(),
    companiesRoot(),
    sessionsRoot(),
    artifactsRoot(),
    skillsRoot(),
    globalConfigPath(),
    mcpConfigPath(),
    path.join(root, 'tasks'),
    path.join(root, 'mcp'),
    path.join(root, 'agents'),
    path.join(root, 'recipes'),
  ]
  for (const abs of topLevel) {
    if (!fs.existsSync(abs)) continue
    const rel = path.relative(root, abs)
    if (!rel || rel.startsWith('..')) continue
    if (isExcluded(rel)) continue
    candidates.push({ abs, rel })
  }
  return candidates
}

function copyFiltered(src: string, dst: string) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      if (EXCLUDED_FILE_NAMES.has(entry)) continue
      if (EXCLUDED_SEGMENTS.has(entry)) continue
      copyFiltered(path.join(src, entry), path.join(dst, entry))
    }
  } else if (stat.isFile()) {
    if (EXCLUDED_FILE_NAMES.has(path.basename(src))) return
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

async function snapshotSqlite(src: string, dst: string): Promise<void> {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const db = new Database(src, { readonly: true, fileMustExist: true })
  try {
    // better-sqlite3 12.x: db.backup(dst) returns a Promise.
    await db.backup(dst)
  } finally {
    db.close()
  }
}

async function overwriteDbsWithSnapshots(staging: string): Promise<void> {
  const root = dataDir()
  const engineDb = dbPath()
  if (fs.existsSync(engineDb)) {
    const relDb = path.relative(root, engineDb)
    await snapshotSqlite(engineDb, path.join(staging, relDb))
  }
  const companies = companiesRoot()
  if (fs.existsSync(companies)) {
    for (const company of fs.readdirSync(companies)) {
      const teamsDir = path.join(companies, company, 'teams')
      if (!fs.existsSync(teamsDir)) continue
      for (const teamEntry of fs.readdirSync(teamsDir)) {
        const teamPath = path.join(teamsDir, teamEntry)
        const stat = fs.statSync(teamPath)
        if (!stat.isDirectory()) continue
        const dataDb = path.join(teamPath, 'data.db')
        if (!fs.existsSync(dataDb)) continue
        const rel = path.relative(root, dataDb)
        await snapshotSqlite(dataDb, path.join(staging, rel))
      }
    }
  }
}

export function currentBackupFilename(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `openhive-backup-${stamp}.tar.gz`
}

export async function createBackupStream(): Promise<{ stream: Readable; cleanup: () => void }> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-backup-'))
  const root = dataDir()

  const includes = listIncludeRoots()
  for (const { abs, rel } of includes) {
    copyFiltered(abs, path.join(staging, rel))
  }
  await overwriteDbsWithSnapshots(staging)

  const entries = fs
    .readdirSync(staging)
    .filter((e) => !EXCLUDED_FILE_NAMES.has(e) && !EXCLUDED_SEGMENTS.has(e))

  // No content — ship a single marker so tar has something to emit.
  if (entries.length === 0) {
    fs.writeFileSync(
      path.join(staging, 'README.txt'),
      `OpenHive backup from ${new Date().toISOString()}\nSource: ${root}\n(empty install — no user data)\n`,
    )
    entries.push('README.txt')
  }

  // tar.c returns a Minipass stream — `Readable.toWeb` rejects it with
  // ERR_INVALID_ARG_TYPE. Bridge through a real Node PassThrough.
  const tarStream = tar.c({ gzip: true, cwd: staging, portable: true }, entries)
  const stream = new PassThrough()
  ;(tarStream as unknown as NodeJS.ReadableStream).pipe(stream)

  const cleanup = () => {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  stream.on('end', cleanup)
  stream.on('close', cleanup)
  stream.on('error', cleanup)

  return { stream: stream as Readable, cleanup }
}
