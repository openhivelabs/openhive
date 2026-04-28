#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const serverEntry = path.resolve(pkgRoot, 'dist-server', 'server', 'index.js')
const pkg = JSON.parse(fs.readFileSync(path.resolve(pkgRoot, 'package.json'), 'utf8'))
const VERSION = pkg.version

process.env.NODE_ENV ??= 'production'
const PORT = Number(process.env.PORT ?? 4483)
const HOST = process.env.HOST ?? '127.0.0.1'
const LOOPBACK = new Set(['127.0.0.1', '::1', '0.0.0.0', 'localhost'])
const DISPLAY_HOST = LOOPBACK.has(HOST.toLowerCase()) ? 'localhost' : HOST
const URL_BASE = `http://${DISPLAY_HOST}:${PORT}`

const logsDir = path.join(os.homedir(), '.openhive', 'logs')
fs.mkdirSync(logsDir, { recursive: true })
const logPath = path.join(logsDir, 'server.log')
const logFd = fs.openSync(logPath, 'a')

const child = spawn(process.execPath, [serverEntry], {
  env: process.env,
  stdio: ['ignore', logFd, logFd],
})

let status = 'starting'
let latest = null
let cursor = 0
let flash = null
let spin = 0
const SPIN = ['◐', '◓', '◑', '◒']
const items = [
  { id: 'web', label: 'Open Web UI in browser' },
  { id: 'tui', label: 'Open Terminal UI' },
  { id: 'exit', label: 'Stop server & exit' },
]

const ESC = '\x1b['
const out = (s) => process.stdout.write(s)
const clear = () => out(`${ESC}2J${ESC}H`)
const hideCursor = () => out(`${ESC}?25l`)
const showCursor = () => out(`${ESC}?25h`)
const altOn = () => out(`${ESC}?1049h`)
const altOff = () => out(`${ESC}?1049l`)

const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length
const padInner = (text, width) => text + ' '.repeat(Math.max(0, width - visLen(text)))

const BOX_W = 46
function box(top) {
  const ch = top === 'top' ? ['╭', '╮'] : top === 'bot' ? ['╰', '╯'] : null
  if (!ch) return ''
  return `${ch[0]}${'─'.repeat(BOX_W)}${ch[1]}`
}
function boxLine(text) {
  return `│${padInner(text, BOX_W)}│`
}

function statusLabel() {
  if (status === 'running') return '\x1b[32m●\x1b[0m running'
  if (status === 'error') return '\x1b[31m●\x1b[0m error'
  return `\x1b[33m${SPIN[spin % SPIN.length]}\x1b[0m starting…`
}

function render() {
  clear()
  out(`${box('top')}\n`)
  out(`${boxLine(`  🐝  OpenHive   v${VERSION}`)}\n`)
  out(`${boxLine(`      ${URL_BASE}    ${statusLabel()}`)}\n`)
  out(`${box('bot')}\n\n`)
  if (latest) {
    out(`   \x1b[36mⓘ\x1b[0m  v${latest} available    press  \x1b[1mu\x1b[0m  to update\n\n`)
  }
  out('   What would you like to do?\n\n')
  for (let i = 0; i < items.length; i++) {
    const sel = i === cursor
    if (sel) {
      out(` \x1b[36m▸\x1b[0m  \x1b[36m\x1b[1m${items[i].label}\x1b[0m\n`)
    } else {
      out(`    ${items[i].label}\n`)
    }
  }
  out('\n')
  const hint = latest
    ? '   ↑/↓ navigate   ⏎ select   q quit   u update'
    : '   ↑/↓ navigate   ⏎ select   q quit'
  out(`\x1b[2m${hint}\x1b[0m\n`)
  if (flash) out(`\n   ${flash}\n`)
}

async function pollReady() {
  while (status === 'starting') {
    try {
      const res = await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) {
        status = 'running'
        render()
        return
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function checkLatest() {
  try {
    const res = await fetch('https://registry.npmjs.org/openhiveai/latest', {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return
    const j = await res.json()
    if (j?.version && semver.valid(j.version) && semver.valid(VERSION) && semver.gt(j.version, VERSION)) {
      latest = j.version
      render()
    }
  } catch {
    // offline / blocked — silently skip
  }
}

function openInBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const args = process.platform === 'win32' ? ['', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
    return true
  } catch {
    return false
  }
}

function setFlash(msg, ms = 2000) {
  flash = msg
  render()
  setTimeout(() => {
    if (flash === msg) {
      flash = null
      render()
    }
  }, ms)
}

async function shutdown(code = 0) {
  process.stdin.removeAllListeners('data')
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.stdin.pause()
  clear()
  out('   ◐  draining events…\n')
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
  showCursor()
  altOff()
  out('   ✓  goodbye.\n')
  try {
    fs.closeSync(logFd)
  } catch {}
  process.exit(code)
}

function onKey(buf) {
  const s = buf.toString('utf8')
  if (s === '\x03' || s === 'q' || s === 'Q') {
    void shutdown(0)
    return
  }
  if (s === '\x1b[A' || s === 'k') {
    cursor = (cursor - 1 + items.length) % items.length
    render()
    return
  }
  if (s === '\x1b[B' || s === 'j') {
    cursor = (cursor + 1) % items.length
    render()
    return
  }
  if (s === 'u' || s === 'U') {
    if (latest) setFlash(`run:  npm i -g openhiveai@${latest}`, 4000)
    return
  }
  if (s === '\r' || s === '\n') {
    const item = items[cursor]
    if (item.id === 'web') {
      if (status !== 'running') {
        setFlash('\x1b[33mserver still starting — try again in a sec\x1b[0m')
        return
      }
      openInBrowser(URL_BASE)
        ? setFlash(`↳  opened ${URL_BASE} in your browser`)
        : setFlash('\x1b[31mfailed to launch browser\x1b[0m')
      return
    }
    if (item.id === 'tui') {
      setFlash('\x1b[2mTerminal UI is not available yet.\x1b[0m')
      return
    }
    if (item.id === 'exit') {
      void shutdown(0)
    }
  }
}

child.on('exit', (code, signal) => {
  if (status !== 'running' && code !== 0) {
    status = 'error'
    flash = `\x1b[31mserver exited (${code ?? signal}). check ${logPath}\x1b[0m`
    render()
  }
})

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

if (!process.stdin.isTTY) {
  console.error('openhiveai requires an interactive terminal (TTY).')
  console.error(`server log: ${logPath}`)
  process.exit(1)
}

altOn()
hideCursor()
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')
process.stdin.on('data', onKey)

render()
const spinTimer = setInterval(() => {
  if (status === 'starting') {
    spin++
    render()
  } else {
    clearInterval(spinTimer)
  }
}, 200)

void pollReady()
void checkLatest()
