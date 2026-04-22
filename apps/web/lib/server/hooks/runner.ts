/**
 * Single hook process runner — spawns the command, writes JSON to stdin,
 * captures stdout/stderr (1 MB cap each), enforces timeout with
 * AbortController + SIGKILL fallback.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

import type { HookEntry, RunOneResult } from './types'

function resolveDataDir(): string {
  return process.env.OPENHIVE_DATA_DIR ?? path.join(homedir(), '.openhive')
}

const STDIO_CAP = 1_048_576 // 1 MB

export interface RunOneEnvExtras {
  OPENHIVE_HOOK_EVENT: string
  OPENHIVE_SESSION_ID?: string
  OPENHIVE_COMPANY_ID?: string
  OPENHIVE_TEAM_ID?: string
  OPENHIVE_TRANSCRIPT_PATH?: string
}

export async function runOne(
  entry: HookEntry,
  payload: unknown,
  envExtras: RunOneEnvExtras,
): Promise<RunOneResult> {
  const ac = new AbortController()
  const t0 = Date.now()

  let timedOut = false
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENHIVE_DATA_DIR: resolveDataDir(),
    ...envExtras,
  }

  return await new Promise<RunOneResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(entry.command, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: ac.signal,
        env,
      })
    } catch (exc) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: `spawn failed: ${(exc as Error).message}`,
        durationMs: Date.now() - t0,
        timedOut: false,
      })
      return
    }

    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= STDIO_CAP) return
      const room = STDIO_CAP - stdoutBytes
      if (chunk.length > room) {
        stdoutChunks.push(chunk.subarray(0, room))
        stdoutBytes = STDIO_CAP
        if (!stdoutTruncated) {
          stdoutTruncated = true
          console.warn(`[hooks] stdout > 1MB, truncating (${entry.command})`)
        }
      } else {
        stdoutChunks.push(chunk)
        stdoutBytes += chunk.length
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= STDIO_CAP) return
      const room = STDIO_CAP - stderrBytes
      if (chunk.length > room) {
        stderrChunks.push(chunk.subarray(0, room))
        stderrBytes = STDIO_CAP
        if (!stderrTruncated) {
          stderrTruncated = true
          console.warn(`[hooks] stderr > 1MB, truncating (${entry.command})`)
        }
      } else {
        stderrChunks.push(chunk)
        stderrBytes += chunk.length
      }
    })

    const killTimer = setTimeout(() => {
      timedOut = true
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
      // If the child doesn't die within 2s after SIGTERM, SIGKILL.
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 2000)
    }, entry.timeout)

    const finish = (exitCode: number, errMsg?: string) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = (errMsg ? `${errMsg}\n` : '') + Buffer.concat(stderrChunks).toString('utf8')
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - t0,
        timedOut,
      })
    }

    child.on('error', (err) => {
      // AbortError from AbortController fires as error; treat as timeout case.
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        finish(-2, 'aborted (timeout)')
      } else {
        finish(-1, `spawn error: ${err.message}`)
      }
    })

    child.on('close', (code, signal) => {
      if (settled) return
      if (timedOut) {
        finish(-2, `timed out after ${entry.timeout}ms (signal=${signal ?? 'none'})`)
      } else {
        finish(code ?? -1)
      }
    })

    // Write stdin and close.
    try {
      const payloadStr = JSON.stringify(payload)
      child.stdin?.end(payloadStr)
    } catch (exc) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      finish(-1, `stdin write failed: ${(exc as Error).message}`)
    }
  })
}
