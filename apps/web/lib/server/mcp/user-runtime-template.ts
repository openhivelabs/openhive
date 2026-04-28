/**
 * Runtime wrapper prepended to AI-generated user MCP `server.js`.
 *
 * Goal: give the user-authored code a tight, declarative sandbox:
 *   - outbound HTTP limited to `allowed_hosts` (fetch monkey-patch)
 *   - dangerous Node modules (child_process, fs write, net raw) blocked
 *   - credentials injected via `process.env[envName]`, with automatic masking
 *     on stderr so accidental `console.error(token)` doesn't leak
 *   - the server file must assign its MCP `Server` instance to `globalThis.__mcpServer`
 *
 * The template is a string so we can stamp per-server manifest values at
 * install time. AI never writes this — only the body that follows the
 * "// ---- user code below ----" marker.
 */

interface RuntimeManifestData {
  allowed_hosts: string[]
  credential_env_names: string[]
}

export function buildUserMcpBootstrap(data: RuntimeManifestData): string {
  const allowed = JSON.stringify(data.allowed_hosts)
  const credNames = JSON.stringify(data.credential_env_names)
  return `#!/usr/bin/env node
// AUTO-GENERATED BOOTSTRAP — do not edit. Edit server.user.js instead.
// Enforces allowed_hosts, blocks dangerous modules, masks credentials.

'use strict'

const __ALLOWED_HOSTS = new Set(${allowed})
const __CRED_ENV_NAMES = ${credNames}

// --- credential masking on stderr ---
// Any console.error / process.stderr.write containing a credential value is
// scrubbed before it leaves the process. stdout is MCP protocol only; we do
// NOT touch it. Values below 8 chars are ignored to avoid false positives.
const __secretValues = __CRED_ENV_NAMES
  .map((k) => process.env[k])
  .filter((v) => typeof v === 'string' && v.length >= 8)
function __scrub(s) {
  if (typeof s !== 'string') return s
  let out = s
  for (const v of __secretValues) {
    while (out.includes(v)) out = out.replace(v, '[REDACTED]')
  }
  return out
}
const __origStderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = function (chunk, enc, cb) {
  if (typeof chunk === 'string') return __origStderrWrite(__scrub(chunk), enc, cb)
  return __origStderrWrite(chunk, enc, cb)
}

// --- outbound fetch host allowlist ---
const __origFetch = globalThis.fetch
if (typeof __origFetch === 'function') {
  globalThis.fetch = async function (input, init) {
    let url
    try {
      url = typeof input === 'string' || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url)
    } catch (e) {
      throw new Error('[openhive:mcp-user] invalid fetch URL')
    }
    if (!__ALLOWED_HOSTS.has(url.host)) {
      throw new Error(
        '[openhive:mcp-user] host not allowed: ' + url.host +
        '. Only these hosts are allowed: ' + [...__ALLOWED_HOSTS].join(', ')
      )
    }
    return __origFetch.call(this, input, init)
  }
}

// --- block dangerous node modules ---
const Module = require('node:module')
const __BLOCKED = new Set(['child_process', 'node:child_process', 'worker_threads', 'node:worker_threads', 'vm', 'node:vm', 'net', 'node:net', 'dgram', 'node:dgram'])
const __origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (__BLOCKED.has(String(request))) {
    throw new Error('[openhive:mcp-user] module blocked: ' + request)
  }
  return __origResolve.call(this, request, parent, ...rest)
}

// --- no unlink / writeFile on random paths (allow tmp only) ---
const fs = require('node:fs')
const os = require('node:os')
const __TMP = os.tmpdir()
function __assertTmpPath(p) {
  const abs = require('node:path').resolve(String(p))
  if (!abs.startsWith(__TMP + require('node:path').sep) && abs !== __TMP) {
    throw new Error('[openhive:mcp-user] fs write outside tmpdir not allowed: ' + abs)
  }
}
for (const fn of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rename', 'renameSync', 'mkdir', 'mkdirSync']) {
  const orig = fs[fn]
  if (typeof orig === 'function') {
    fs[fn] = function (p, ...rest) { __assertTmpPath(p); return orig.call(this, p, ...rest) }
  }
}

// --- load user code ---
require('./server.user.js')
`
}
