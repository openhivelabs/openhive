/**
 * AI-generated user MCP servers — install/approve/list/delete.
 *
 * Each server lives at ~/.openhive/mcp-user/<name>/ with:
 *   - manifest.json       declarative security metadata (allowed_hosts, creds)
 *   - server.user.js      AI-written MCP server body
 *   - server.js           bootstrap that prepends runtime wrapper + requires user.js
 *   - package.json        minimal, no deps (symlink'd node_modules at runtime)
 *   - .approved           sha256(server.user.js + manifest.json) once user approves
 *
 * Nothing here executes code — install() just writes files and returns. Actual
 * spawn happens through the existing MCP manager when a panel binding refers
 * to the server. `approve()` adds the entry to mcp.yaml so the manager knows
 * it exists.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { userMcpDir, webAppNodeModules } from '../paths'
import * as mcpConfig from './config'
import { buildUserMcpBootstrap } from './user-runtime-template'

export const USER_PRESET_ID = '__user_generated__'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/

interface UserMcpCredentialSpec {
  ref_id: string       // credential vault ref
  env_name: string     // env var name the user code reads
  purpose: string      // human-readable reason (shown in approval UI)
}

interface UserMcpToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
  side_effects: 'read' | 'write'
}

interface UserMcpManifest {
  name: string
  description: string
  allowed_hosts: string[]
  required_credentials: UserMcpCredentialSpec[]
  tools: UserMcpToolSpec[]
}

interface UserMcpRecord {
  name: string
  manifest: UserMcpManifest
  code: string
  installed_at: number
  approved: boolean
  approved_hash: string | null
}

// -------- validation --------

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const CRED_REF_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/

function validateManifest(m: unknown): UserMcpManifest {
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error('manifest must be an object')
  }
  const o = m as Record<string, unknown>
  if (typeof o.name !== 'string' || !NAME_RE.test(o.name)) {
    throw new Error('manifest.name: 2-32 lowercase alphanum/-/_')
  }
  if (typeof o.description !== 'string' || !o.description.trim()) {
    throw new Error('manifest.description required')
  }
  if (!Array.isArray(o.allowed_hosts) || o.allowed_hosts.length === 0) {
    throw new Error('manifest.allowed_hosts: non-empty array required')
  }
  for (const h of o.allowed_hosts) {
    if (typeof h !== 'string' || !HOST_RE.test(h.toLowerCase())) {
      throw new Error(`manifest.allowed_hosts: invalid host ${JSON.stringify(h)}`)
    }
  }
  const creds: UserMcpCredentialSpec[] = []
  if (o.required_credentials !== undefined) {
    if (!Array.isArray(o.required_credentials)) {
      throw new Error('manifest.required_credentials must be array')
    }
    for (const c of o.required_credentials) {
      if (!c || typeof c !== 'object') throw new Error('credential entry must be object')
      const cc = c as Record<string, unknown>
      if (typeof cc.ref_id !== 'string' || !CRED_REF_RE.test(cc.ref_id)) {
        throw new Error(`credential.ref_id invalid: ${JSON.stringify(cc.ref_id)}`)
      }
      if (typeof cc.env_name !== 'string' || !ENV_NAME_RE.test(cc.env_name)) {
        throw new Error(`credential.env_name invalid: ${JSON.stringify(cc.env_name)}`)
      }
      if (typeof cc.purpose !== 'string' || !cc.purpose.trim()) {
        throw new Error('credential.purpose required')
      }
      creds.push({ ref_id: cc.ref_id, env_name: cc.env_name, purpose: cc.purpose })
    }
  }
  const tools: UserMcpToolSpec[] = []
  if (!Array.isArray(o.tools) || o.tools.length === 0) {
    throw new Error('manifest.tools: at least one tool required')
  }
  for (const t of o.tools) {
    if (!t || typeof t !== 'object') throw new Error('tool entry must be object')
    const tt = t as Record<string, unknown>
    if (typeof tt.name !== 'string' || !tt.name) throw new Error('tool.name required')
    if (typeof tt.description !== 'string') throw new Error('tool.description required')
    if (!tt.input_schema || typeof tt.input_schema !== 'object') {
      throw new Error('tool.input_schema required')
    }
    if (tt.side_effects !== 'read' && tt.side_effects !== 'write') {
      throw new Error('tool.side_effects must be "read" or "write"')
    }
    tools.push({
      name: tt.name,
      description: tt.description,
      input_schema: tt.input_schema as Record<string, unknown>,
      side_effects: tt.side_effects,
    })
  }
  return {
    name: o.name,
    description: o.description,
    allowed_hosts: (o.allowed_hosts as string[]).map((s) => s.toLowerCase()),
    required_credentials: creds,
    tools,
  }
}

/** Refuse obvious hardcoded-secret patterns and dangerous constructs so AI
 *  can't ship a "plain text API key in source" server even by mistake. */
function scanCodeForIssues(code: string): string[] {
  const issues: string[] = []
  const patterns: Array<{ re: RegExp; msg: string }> = [
    { re: /sk-[A-Za-z0-9]{20,}/, msg: 'likely hardcoded OpenAI-style secret' },
    { re: /ghp_[A-Za-z0-9]{20,}/, msg: 'likely hardcoded GitHub PAT' },
    { re: /xox[bp]-[A-Za-z0-9-]{10,}/, msg: 'likely hardcoded Slack token' },
    { re: /Bearer\s+[A-Za-z0-9_\-]{20,}/i, msg: 'hardcoded Bearer token literal' },
    { re: /AKIA[0-9A-Z]{16}/, msg: 'likely hardcoded AWS access key' },
    { re: /\beval\s*\(/, msg: 'eval() is not permitted' },
    { re: /new\s+Function\s*\(/, msg: 'new Function() is not permitted' },
  ]
  for (const { re, msg } of patterns) {
    if (re.test(code)) issues.push(msg)
  }
  return issues
}

// -------- fs helpers --------

function serverDir(name: string): string {
  return path.join(userMcpDir(), name)
}

function manifestPath(name: string): string {
  return path.join(serverDir(name), 'manifest.json')
}

function userCodePath(name: string): string {
  return path.join(serverDir(name), 'server.user.js')
}

function bootstrapPath(name: string): string {
  return path.join(serverDir(name), 'server.js')
}

function approvedPath(name: string): string {
  return path.join(serverDir(name), '.approved')
}

function pkgJsonPath(name: string): string {
  return path.join(serverDir(name), 'package.json')
}

function hashContent(manifest: UserMcpManifest, code: string): string {
  const h = crypto.createHash('sha256')
  h.update(JSON.stringify(manifest))
  h.update('\n')
  h.update(code)
  return h.digest('hex')
}

/** Ensure `~/.openhive/mcp-user/node_modules` points to the web app's
 *  node_modules so user server.js can require SDK + transitive deps. Idempotent. */
function ensureSharedNodeModules(): void {
  const link = path.join(userMcpDir(), 'node_modules')
  const target = webAppNodeModules()
  if (!fs.existsSync(target)) return // give up silently — fallback is NODE_PATH
  try {
    const existing = fs.lstatSync(link)
    if (existing.isSymbolicLink()) {
      const current = fs.readlinkSync(link)
      if (path.resolve(current) === path.resolve(target)) return
      fs.unlinkSync(link)
    } else {
      // someone made a real dir/file there — don't clobber
      return
    }
  } catch {
    /* link doesn't exist yet */
  }
  fs.mkdirSync(userMcpDir(), { recursive: true })
  try {
    fs.symlinkSync(target, link, 'dir')
  } catch {
    /* best effort — spawn will fail with a clearer error if SDK is missing */
  }
}

// -------- public API --------

export function installUserServer(input: {
  manifest: unknown
  code: string
}): UserMcpRecord {
  const manifest = validateManifest(input.manifest)
  const code = String(input.code ?? '')
  if (!code.trim()) throw new Error('code: non-empty source required')
  const issues = scanCodeForIssues(code)
  if (issues.length > 0) {
    throw new Error(`code rejected: ${issues.join('; ')}`)
  }
  const dir = serverDir(manifest.name)
  fs.mkdirSync(dir, { recursive: true })
  ensureSharedNodeModules()
  fs.writeFileSync(manifestPath(manifest.name), JSON.stringify(manifest, null, 2), 'utf8')
  fs.writeFileSync(userCodePath(manifest.name), code, 'utf8')
  const bootstrap = buildUserMcpBootstrap({
    allowed_hosts: manifest.allowed_hosts,
    credential_env_names: manifest.required_credentials.map((c) => c.env_name),
  })
  fs.writeFileSync(bootstrapPath(manifest.name), bootstrap, 'utf8')
  const pkg = {
    name: `openhive-user-mcp-${manifest.name}`,
    version: '0.0.0',
    private: true,
    type: 'commonjs',
  }
  fs.writeFileSync(pkgJsonPath(manifest.name), JSON.stringify(pkg, null, 2), 'utf8')
  // mark as NOT approved — re-install always invalidates prior approval
  try {
    fs.rmSync(approvedPath(manifest.name), { force: true })
  } catch {
    /* ignore */
  }
  return {
    name: manifest.name,
    manifest,
    code,
    installed_at: Date.now(),
    approved: false,
    approved_hash: null,
  }
}

export function approveUserServer(name: string): UserMcpRecord {
  const rec = loadUserServer(name)
  if (!rec) throw new Error(`user MCP server not found: ${name}`)
  ensureSharedNodeModules()
  const hash = hashContent(rec.manifest, rec.code)
  fs.writeFileSync(approvedPath(name), hash, 'utf8')
  // register/refresh entry in mcp.yaml so manager can spawn it
  mcpConfig.upsertServer(name, {
    command: 'node',
    args: [bootstrapPath(name)],
    env: {},
    preset_id: USER_PRESET_ID,
  })
  return { ...rec, approved: true, approved_hash: hash }
}

export function deleteUserServer(name: string): boolean {
  const dir = serverDir(name)
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  mcpConfig.deleteServer(name)
  return true
}

export function loadUserServer(name: string): UserMcpRecord | null {
  const dir = serverDir(name)
  if (!fs.existsSync(dir)) return null
  let manifest: UserMcpManifest
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath(name), 'utf8')))
  } catch {
    return null
  }
  let code: string
  try {
    code = fs.readFileSync(userCodePath(name), 'utf8')
  } catch {
    return null
  }
  let approved_hash: string | null = null
  try {
    approved_hash = fs.readFileSync(approvedPath(name), 'utf8').trim()
  } catch {
    approved_hash = null
  }
  const current = hashContent(manifest, code)
  const approved = approved_hash != null && approved_hash === current
  let installed_at = 0
  try {
    installed_at = fs.statSync(manifestPath(name)).mtimeMs
  } catch {
    /* ignore */
  }
  return { name, manifest, code, installed_at, approved, approved_hash }
}

export function listUserServers(): UserMcpRecord[] {
  const dir = userMcpDir()
  if (!fs.existsSync(dir)) return []
  const out: UserMcpRecord[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const rec = loadUserServer(entry.name)
    if (rec) out.push(rec)
  }
  return out
}

/** Spawn-time guard: throw if approval hash doesn't match current files.
 *  Called from manager.buildTransport right before starting the child. */
export function assertApprovedAndCurrent(name: string): UserMcpManifest {
  const rec = loadUserServer(name)
  if (!rec) throw new Error(`user MCP server not installed: ${name}`)
  if (!rec.approved) {
    throw new Error(
      `user MCP server "${name}" has not been approved. Open Settings → MCP to review and approve.`,
    )
  }
  return rec.manifest
}
