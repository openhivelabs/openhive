import { Readable } from 'node:stream'
import { createBackupStream, currentBackupFilename } from '@/lib/server/backup/bundler'
import { Hono } from 'hono'

export const backup = new Hono()

backup.get('/download', async (c) => {
  const filename = currentBackupFilename()
  let bundle: Awaited<ReturnType<typeof createBackupStream>>
  try {
    bundle = await createBackupStream()
  } catch (err) {
    console.error('[backup] failed to build stream', err)
    return c.json({ error: 'backup_build_failed', detail: String(err) }, 500)
  }

  const webStream = Readable.toWeb(bundle.stream) as ReadableStream<Uint8Array>
  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
})
