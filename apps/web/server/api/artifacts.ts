import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getArtifact, listForSession, listForTeam } from '@/lib/server/artifacts'
import { resolveArtifactUri } from '@/lib/server/sessions/artifacts'
import { Hono } from 'hono'

export const artifacts = new Hono()

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

// GET /api/artifacts?session_id=... | ?team_id=...
artifacts.get('/', (c) => {
  const sessionId = c.req.query('session_id')
  const teamId = c.req.query('team_id')
  if (sessionId) return c.json(listForSession(sessionId))
  if (teamId) return c.json(listForTeam(teamId))
  return c.json({ detail: 'team_id or session_id required' }, 400)
})

// GET /api/artifacts/by-uri?uri=artifact://session/{sid}/artifacts/{rel}[&disposition=inline]
// Resolves an artifact:// URI (as written by agents in their final messages)
// to the underlying file and streams it. `?disposition=inline` serves the
// file with inline Content-Disposition so <img> previews work; default is
// attachment (download).
artifacts.get('/by-uri', (c) => {
  const uri = c.req.query('uri')
  if (!uri || !uri.startsWith('artifact://')) {
    return c.json({ detail: 'uri query param required' }, 400)
  }
  const sidMatch = uri.match(/^artifact:\/\/session\/([^/]+)\//)
  if (!sidMatch) return c.json({ detail: 'invalid uri' }, 400)
  const sessionId = sidMatch[1]!
  const resolved = resolveArtifactUri(uri, { callerSessionId: sessionId })
  if (!resolved.ok) {
    const status =
      resolved.reason === 'not_found'
        ? 404
        : resolved.reason === 'traversal' || resolved.reason === 'outside_root'
          ? 400
          : 400
    return c.json({ detail: resolved.reason }, status)
  }
  const abs = resolved.resolved.absPath
  const filename = path.basename(abs)
  const mime = mimeFor(filename)
  const stream = fs.createReadStream(abs) as unknown as ReadableStream
  const disposition = c.req.query('disposition') === 'inline' ? 'inline' : 'attachment'
  return c.body(stream, 200, {
    'Content-Type': mime,
    'Content-Disposition': `${disposition}; filename="${filename}"`,
    'Content-Length': String(fs.statSync(abs).size),
  })
})

// GET /api/artifacts/:artifactId/download
artifacts.get('/:artifactId/download', (c) => {
  const artifactId = c.req.param('artifactId')
  const art = getArtifact(artifactId)
  if (!art) {
    return c.json({ detail: 'Artifact not found' }, 404)
  }
  if (!fs.existsSync(art.path) || !fs.statSync(art.path).isFile()) {
    return c.json({ detail: 'Artifact file missing on disk' }, 410)
  }
  const stream = fs.createReadStream(art.path) as unknown as ReadableStream
  return c.body(stream, 200, {
    'Content-Type': art.mime ?? 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${path.basename(art.filename)}"`,
    'Content-Length': String(art.size ?? fs.statSync(art.path).size),
  })
})

function revealInFinder(absPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform
    let cmd: string
    let args: string[]
    if (platform === 'darwin') {
      // Reveal the file itself in Finder (select it inside its parent folder).
      cmd = 'open'
      args = ['-R', absPath]
    } else if (platform === 'win32') {
      cmd = 'explorer'
      args = [`/select,${absPath}`]
    } else {
      // Linux / other: best we can do is open the parent directory.
      cmd = 'xdg-open'
      args = [path.dirname(absPath)]
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', reject)
    child.unref()
    // We don't wait for the process — detached and we don't care about exit
    // code (Windows `explorer /select` returns 1 even on success).
    resolve()
  })
}

// POST /api/artifacts/:artifactId/reveal
artifacts.post('/:artifactId/reveal', async (c) => {
  const artifactId = c.req.param('artifactId')
  const art = getArtifact(artifactId)
  if (!art) {
    return c.json({ detail: 'Artifact not found' }, 404)
  }
  if (!fs.existsSync(art.path)) {
    return c.json({ detail: 'Artifact file missing on disk' }, 410)
  }
  try {
    await revealInFinder(art.path)
    return c.json({ ok: true })
  } catch (exc) {
    return c.json({ detail: exc instanceof Error ? exc.message : String(exc) }, 500)
  }
})
