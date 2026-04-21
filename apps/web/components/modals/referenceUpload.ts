import type { TaskReference } from '@/lib/types'

/** Max inline text content we keep in memory per file. Larger files are truncated. */
const MAX_INLINE_BYTES = 256 * 1024

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx', '.py',
  '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp',
  '.sh', '.bash', '.sql', '.toml', '.ini', '.conf', '.log',
])

function isTextFile(name: string, mime: string): boolean {
  if (mime.startsWith('text/')) return true
  if (mime === 'application/json') return true
  if (mime === 'application/xml') return true
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot >= 0 && TEXT_EXT.has(lower.slice(dot))) return true
  return false
}

function randomId() {
  return `ref-${Math.random().toString(36).slice(2, 10)}`
}

export async function readAsReference(file: File): Promise<TaskReference> {
  const kind: TaskReference['kind'] = isTextFile(file.name, file.type) ? 'text' : 'binary'
  let content: string | undefined
  if (kind === 'text') {
    const slice = file.slice(0, MAX_INLINE_BYTES)
    content = await slice.text()
    if (file.size > MAX_INLINE_BYTES) {
      content += `\n\n…[truncated from ${file.size} bytes]`
    }
  }
  return {
    id: randomId(),
    name: file.name,
    size: file.size,
    kind,
    content,
  }
}
