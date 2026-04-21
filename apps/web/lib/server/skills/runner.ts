/**
 * Skill subprocess runner.
 * Ports apps/server/openhive/skills/runner.py.
 *
 * Contract with skill scripts:
 *   - Spawned with `python <entrypoint>` or `node <entrypoint>`.
 *   - Parameters arrive as JSON on stdin.
 *   - Generated files go into OPENHIVE_OUTPUT_DIR (set via env). Before/after
 *     snapshot of that directory produces the artifact list.
 *   - Stdout is captured verbatim (truncated to ~8 KB) and surfaced to the LLM.
 *   - Non-zero exit = failure; stderr rides along in the tool error.
 *
 * Hard timeout (default 120 s) prevents a hung skill from blocking the run.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import which from './which'
import {
  MAX_READABLE_FILE_BYTES,
  resolveWithinSkill,
  type SkillDef,
} from './loader'

export const DEFAULT_TIMEOUT_MS = 120_000
export const STDOUT_CAP_BYTES = 8 * 1024

export interface GeneratedFile {
  name: string
  path: string
  mime: string
  size: number
}

export interface SkillResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
  files: GeneratedFile[]
  timedOut: boolean
}

function interpreter(runtime: 'python' | 'node'): string {
  if (runtime === 'python') {
    // Prefer python3 from PATH; python2 is long dead.
    return which('python3') ?? which('python') ?? 'python3'
  }
  if (runtime === 'node') {
    const node = which('node')
    if (!node) throw new Error('node interpreter not found on PATH')
    return node
  }
  throw new Error(`unsupported runtime: ${JSON.stringify(runtime)}`)
}

function snapshot(dir: string): Set<string> {
  const out = new Set<string>()
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) out.add(abs)
    }
  }
  walk(dir)
  return out
}

function truncate(text: string, cap: number): string {
  if (Buffer.byteLength(text, 'utf8') <= cap) return text
  const buf = Buffer.from(text, 'utf8')
  return `${buf.subarray(0, cap).toString('utf8')}\n…[truncated, ${buf.length - cap} more bytes]`
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
}

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

interface SpawnOpts {
  cmd: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdinBytes: Buffer
  timeoutMs: number
  outputDir: string
}

async function runSubprocess(
  opts: SpawnOpts,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const [bin, ...rest] = opts.cmd
  if (!bin) throw new Error('empty command')
  return new Promise((resolve) => {
    const child = spawn(bin, rest, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const HARD_CAP = 10 * 1024 * 1024 // 10MB hard cap on captured streams

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < HARD_CAP) {
        stdoutChunks.push(chunk)
        stdoutBytes += chunk.length
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < HARD_CAP) {
        stderrChunks.push(chunk)
        stderrBytes += chunk.length
      }
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: truncate(
          Buffer.concat(stdoutChunks).toString('utf8'),
          STDOUT_CAP_BYTES,
        ),
        stderr: truncate(
          Buffer.concat(stderrChunks).toString('utf8'),
          STDOUT_CAP_BYTES,
        ),
        exitCode: code ?? -1,
        timedOut,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: -1,
        timedOut: false,
      })
    })

    child.stdin.end(opts.stdinBytes)
  })
}

function collectNewFiles(outputDir: string, before: Set<string>): GeneratedFile[] {
  const after = snapshot(outputDir)
  const newPaths = [...after].filter((p) => !before.has(p)).sort()
  const files: GeneratedFile[] = []
  for (const abs of newPaths) {
    let size: number
    try {
      size = fs.statSync(abs).size
    } catch {
      continue
    }
    files.push({
      name: path.relative(outputDir, abs).split(path.sep).join('/'),
      path: abs,
      mime: guessMime(abs),
      size,
    })
  }
  return files
}

export async function runSkill(
  skill: SkillDef,
  args: Record<string, unknown>,
  outputDir: string,
  opts: { timeoutMs?: number } = {},
): Promise<SkillResult> {
  if (skill.kind !== 'typed' || !skill.entrypoint || !skill.runtime) {
    throw new Error(
      `runSkill requires a typed skill with an entrypoint, got ${skill.kind}`,
    )
  }
  fs.mkdirSync(outputDir, { recursive: true })
  const before = snapshot(outputDir)
  const bin = interpreter(skill.runtime)
  const env = {
    ...process.env,
    OPENHIVE_OUTPUT_DIR: outputDir,
    OPENHIVE_SKILL_NAME: skill.name,
  }
  const result = await runSubprocess({
    cmd: [bin, skill.entrypoint],
    // cwd = outputDir so relative --out paths land in the artifact directory
    // and the before/after snapshot can actually register new files. Scripts
    // that need skill resources use OPENHIVE_SKILL_DIR or __file__-based
    // resolution, not cwd.
    cwd: outputDir,
    env,
    stdinBytes: Buffer.from(JSON.stringify(args), 'utf8'),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputDir,
  })
  const files = collectNewFiles(outputDir, before)
  // Leave no trace when the subprocess produced nothing — keeps the
  // sessions/{uuid}/ layout clean ("artifacts/ only exists when files
  // were actually generated").
  if (files.length === 0 && before.size === 0) {
    try { fs.rmdirSync(outputDir) } catch { /* dir might have stray non-file entries */ }
  }
  return {
    ...result,
    files,
    ok: !result.timedOut && result.exitCode === 0,
  }
}

function runtimeForScript(scriptPath: string): 'python' | 'node' {
  const suffix = path.extname(scriptPath).toLowerCase()
  if (suffix === '.py') return 'python'
  if (suffix === '.js' || suffix === '.mjs' || suffix === '.cjs') return 'node'
  throw new Error(`unsupported script extension: ${JSON.stringify(suffix)}`)
}

export async function runSkillScript(
  skill: SkillDef,
  scriptRelPath: string,
  outputDir: string,
  opts: {
    args?: string[]
    stdinText?: string | null
    timeoutMs?: number
  } = {},
): Promise<SkillResult> {
  const resolved = resolveWithinSkill(skill, scriptRelPath)
  if (!resolved) {
    return {
      ok: false,
      stdout: '',
      stderr: `script not found inside skill: ${JSON.stringify(scriptRelPath)}`,
      exitCode: -1,
      files: [],
      timedOut: false,
    }
  }
  const runtime = runtimeForScript(resolved)
  const bin = interpreter(runtime)
  fs.mkdirSync(outputDir, { recursive: true })
  const before = snapshot(outputDir)
  const env = {
    ...process.env,
    OPENHIVE_OUTPUT_DIR: outputDir,
    OPENHIVE_SKILL_NAME: skill.name,
    OPENHIVE_SKILL_DIR: skill.skillDir,
  }
  const result = await runSubprocess({
    cmd: [bin, resolved, ...(opts.args ?? [])],
    // cwd = outputDir: relative --out paths land in artifacts, snapshot works.
    cwd: outputDir,
    env,
    stdinBytes: Buffer.from(opts.stdinText ?? '', 'utf8'),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputDir,
  })
  const files = collectNewFiles(outputDir, before)
  // Leave no trace when the subprocess produced nothing — keeps the
  // sessions/{uuid}/ layout clean ("artifacts/ only exists when files
  // were actually generated").
  if (files.length === 0 && before.size === 0) {
    try { fs.rmdirSync(outputDir) } catch { /* dir might have stray non-file entries */ }
  }
  return {
    ...result,
    files,
    ok: !result.timedOut && result.exitCode === 0,
  }
}

const BINARY_EXTS = new Set([
  '.pdf', '.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.mp3', '.mp4', '.wav', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.otf',
])

export function readSkillFile(
  skill: SkillDef,
  relPath: string,
): { content: string | null; error: string | null } {
  const resolved = resolveWithinSkill(skill, relPath)
  if (!resolved) {
    return {
      content: null,
      error: `file not found or outside skill: ${JSON.stringify(relPath)}`,
    }
  }
  const ext = path.extname(resolved).toLowerCase()
  if (BINARY_EXTS.has(ext)) {
    let size = 0
    try {
      size = fs.statSync(resolved).size
    } catch {
      /* ignore */
    }
    return {
      content: null,
      error:
        `refusing to read binary file ${JSON.stringify(relPath)} (${ext}, ${size} bytes). ` +
        `Generated binary artifacts (PDF, DOCX, PPTX, images, etc.) must not be read back into the prompt — ` +
        `they balloon context with no usable text. Trust the run_skill_script success response; ` +
        `the file is already registered as an artifact. Use extract_doc / inspect_doc scripts instead if you need to verify content.`,
    }
  }
  let raw: Buffer
  try {
    raw = fs.readFileSync(resolved)
  } catch (err) {
    return {
      content: null,
      error: `read error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (raw.length > MAX_READABLE_FILE_BYTES) {
    const snippet = raw.subarray(0, MAX_READABLE_FILE_BYTES).toString('utf8')
    return {
      content:
        snippet +
        `\n\n…[truncated, ${raw.length - MAX_READABLE_FILE_BYTES} more bytes — read in chunks if needed]`,
      error: null,
    }
  }
  return { content: raw.toString('utf8'), error: null }
}
