/**
 * OpenAI Codex OAuth callback listener.
 *
 * The shared Codex CLI client_id (`app_EMoamEEZ73f0CkXaXp7hrann`) is
 * registered at OpenAI with a *specific* redirect URI:
 *   http://localhost:1455/auth/callback
 * Any other port or path is rejected at the authorize step with a generic
 * `unknown_error` (OpenAI doesn't spell out "redirect_uri mismatch" for
 * public clients). The web app's Hono server runs on 4487/4483, so we
 * can't just mount `/auth/callback` there. Instead we spawn a tiny
 * secondary HTTP listener on 127.0.0.1:1455 while a Codex auth is in
 * flight, matching the official CLI layout and 9router's
 * `startLocalServer(..., 1455)` pattern.
 *
 * Listener is lazy + singleton + stays warm: once opened, we leave it
 * running across the Node process's lifetime so retries don't pay the
 * bind cost twice. `handleCallback` is idempotent on the flow store.
 */

import http from 'node:http'
import { callbackHtml, handleCallback } from './orchestrator'

const LISTENER_PORT = 1455
const LISTENER_HOST = '127.0.0.1'

let activeServer: http.Server | null = null
let startingPromise: Promise<void> | null = null

/** Spawn (once) the :1455 HTTP listener that catches OpenAI's redirect.
 *  Throws with a clear message if the port is taken by another process —
 *  the official Codex CLI, a previous OpenHive crash, or an unrelated
 *  local app — so the UI can tell the user what to close. */
export async function ensureCodexCallbackListener(): Promise<void> {
  if (activeServer) return
  if (startingPromise) return startingPromise

  startingPromise = new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${LISTENER_HOST}:${LISTENER_PORT}`)
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const p = url.searchParams
      try {
        const result = await handleCallback({
          code: p.get('code'),
          state: p.get('state'),
          flowId: p.get('flow_id'),
          error: p.get('error'),
          errorDescription: p.get('error_description'),
        })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(callbackHtml(result.ok, result.message))
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc)
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(callbackHtml(false, `callback handler crashed: ${message}`))
      }
    })

    const onError = (err: NodeJS.ErrnoException) => {
      startingPromise = null
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${LISTENER_PORT} is already in use. The OpenAI Codex OAuth flow ` +
              `requires this exact port (matches the CLI's registered redirect URI). ` +
              `Close any running \`codex\` CLI instance or another app holding the port ` +
              `and retry.`,
          ),
        )
        return
      }
      reject(err)
    }

    server.once('error', onError)
    server.listen(LISTENER_PORT, LISTENER_HOST, () => {
      server.removeListener('error', onError)
      activeServer = server
      // Non-fatal: if the listener later hits an error, log + allow the
      // next ensure() call to re-bind from scratch.
      server.on('error', (err) => {
        console.warn('[codex-listener] runtime error', err)
      })
      server.on('close', () => {
        if (activeServer === server) activeServer = null
      })
      resolve()
    })
  })

  try {
    await startingPromise
  } finally {
    startingPromise = null
  }
}

/** Test / HMR cleanup hook. Safe to call when nothing is listening. */
export function stopCodexCallbackListener(): void {
  if (activeServer) {
    activeServer.close()
    activeServer = null
  }
}
