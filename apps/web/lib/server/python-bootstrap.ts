/**
 * First-boot Python doctor.
 *
 * Skill subprocesses (xlsx, docx, pptx, pdf, image-gen, web-fetch …) need
 * third-party Python packages (openpyxl, python-docx, python-pptx, reportlab,
 * pypdf, lxml, jsonschema, httpx, jinja2, pyyaml). Asking users to `pip
 * install` separately broke the "npm install openhiveai && openhiveai" UX.
 *
 * Strategy:
 *   1. Find a working system Python (python3 → python → py).
 *   2. Use ~/.openhive/python-venv/ as a managed virtualenv. Probe it for
 *      every required import; if all succeed, export OPENHIVE_PYTHON and
 *      we're done.
 *   3. Otherwise create the venv (idempotent), `pip install -r requirements`,
 *      and re-probe. Stream pip output so first-time users see progress.
 *   4. If nothing works (no python on PATH, network failure, etc.), log a
 *      clear remediation note and let the server boot anyway — the user
 *      can still use non-Python features.
 *
 * Cached on globalThis per the long-lived-state rule, so HMR / tsx-watch
 * don't run the doctor twice in one process lifetime.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths'

const KEY = Symbol.for('openhive.pythonBootstrap')
type Cache = { promise: Promise<string | null> }
const g = globalThis as unknown as Record<symbol, Cache | undefined>

// Modules every skill collectively pulls in. Keep in sync with
// apps/web/python-requirements.txt. Probe imports use the *import* name
// (e.g. python-docx → docx), not the pip name.
const REQUIRED_MODULES = [
  'openpyxl',
  'docx',
  'pptx',
  'reportlab',
  'pypdf',
  'lxml',
  'jsonschema',
  'httpx',
  'jinja2',
  'yaml',
] as const

const SYSTEM_PYTHON_CANDIDATES = ['python3', 'python', 'py']

function findSystemPython(): string | null {
  for (const c of SYSTEM_PYTHON_CANDIDATES) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore' })
    if (r.status === 0) return c
  }
  return null
}

function venvPython(venvDir: string): string {
  // Windows: Scripts\python.exe; everywhere else: bin/python
  const win = process.platform === 'win32'
  return path.join(venvDir, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python')
}

function probeImports(python: string): boolean {
  const code = REQUIRED_MODULES.map((m) => `import ${m}`).join('; ')
  const r = spawnSync(python, ['-c', code], { stdio: 'pipe' })
  return r.status === 0
}

function findRequirementsFile(): string | null {
  // dev: apps/web/python-requirements.txt
  // installed: <pkg>/python-requirements.txt (next to bin/, dist-server/)
  // paths.ts compiles to dist-server/lib/server/, so two parents up gets us
  // to dist-server/, three parents up to the package root.
  // CJS emit — __dirname resolves to dist-server/lib/server/ at runtime, so
  // three parents up is the package root in the installed layout.
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'python-requirements.txt'),
    path.resolve(__dirname, '..', '..', 'python-requirements.txt'),
    path.resolve(process.cwd(), 'python-requirements.txt'),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

function streamSpawn(cmd: string, args: string[], label: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const prefix = `[python:${label}] `
    const log = (chunk: Buffer) => process.stdout.write(prefix + chunk.toString())
    child.stdout.on('data', log)
    child.stderr.on('data', log)
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', (err) => {
      process.stdout.write(`${prefix}spawn error: ${err.message}\n`)
      resolve(1)
    })
  })
}

async function ensurePythonImpl(): Promise<string | null> {
  const venvDir = path.join(dataDir(), 'python-venv')
  const vp = venvPython(venvDir)

  // Fast path: venv already provisioned and intact.
  if (fs.existsSync(vp) && probeImports(vp)) {
    process.env.OPENHIVE_PYTHON = vp
    return vp
  }

  const sys = findSystemPython()
  if (!sys) {
    console.warn(
      '[python] no system python found (tried python3 / python / py). ' +
        'Skills that need Python (xlsx, docx, pptx, pdf, image-gen, web-fetch) ' +
        'will fail until you install Python 3.10+ and restart.',
    )
    return null
  }

  // Last-ditch: maybe system python already has everything (user installed
  // openpyxl etc. globally). Skip venv work in that case — saves ~15s and
  // ~80MB on machines that already paid the cost.
  if (probeImports(sys)) {
    const resolved = spawnSync(sys, ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' })
    const exe = resolved.stdout?.trim()
    if (exe && fs.existsSync(exe)) {
      process.env.OPENHIVE_PYTHON = exe
      return exe
    }
  }

  if (!fs.existsSync(vp)) {
    console.log(`[python] creating venv at ${venvDir} …`)
    const code = await streamSpawn(sys, ['-m', 'venv', venvDir], 'venv')
    if (code !== 0 || !fs.existsSync(vp)) {
      console.warn('[python] venv creation failed. Skills needing Python will fail.')
      return null
    }
  }

  const reqs = findRequirementsFile()
  if (!reqs) {
    console.warn('[python] python-requirements.txt not found — skipping pip install.')
    return null
  }

  console.log(`[python] installing dependencies from ${reqs} (one-time, ~30s) …`)
  const upgradeCode = await streamSpawn(vp, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip')
  if (upgradeCode !== 0) {
    console.warn('[python] pip self-upgrade failed; continuing with bundled pip.')
  }
  const installCode = await streamSpawn(vp, ['-m', 'pip', 'install', '-r', reqs], 'pip')
  if (installCode !== 0) {
    console.warn('[python] pip install failed. Skills needing Python will fail until fixed.')
    return null
  }

  if (!probeImports(vp)) {
    console.warn('[python] post-install import probe still failing.')
    return null
  }

  process.env.OPENHIVE_PYTHON = vp
  console.log('[python] dependencies ready.')
  return vp
}

/** Idempotent — safe to call from server boot. Returns the path to a python
 *  interpreter that has every required module importable, or null if we
 *  couldn't make that happen. Sets OPENHIVE_PYTHON as a side effect. */
export function ensurePython(): Promise<string | null> {
  const cached = g[KEY]
  if (cached) return cached.promise
  const promise = ensurePythonImpl()
  g[KEY] = { promise }
  return promise
}
