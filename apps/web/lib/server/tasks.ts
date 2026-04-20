/**
 * Task persistence as YAML files under ~/.openhive/tasks/.
 * Ports apps/server/openhive/persistence/tasks.py.
 *
 * One file per task so concurrent edits + deletes don't re-serialise siblings.
 * Atomic writes via tmp-file + rename.
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { dataDir } from './paths'

function tasksRoot(): string {
  const root = path.join(dataDir(), 'tasks')
  fs.mkdirSync(root, { recursive: true })
  return root
}

function pathFor(taskId: string): string {
  if (!taskId || taskId.includes('/') || taskId.includes('..')) {
    throw new Error(`invalid task id: ${JSON.stringify(taskId)}`)
  }
  return path.join(tasksRoot(), `${taskId}.yaml`)
}

interface CacheEntry {
  mtime: number
  data: Record<string, unknown>
}

const globalForCache = globalThis as unknown as {
  __openhive_tasks_cache?: Map<string, CacheEntry>
}

function cache(): Map<string, CacheEntry> {
  if (!globalForCache.__openhive_tasks_cache) {
    globalForCache.__openhive_tasks_cache = new Map()
  }
  return globalForCache.__openhive_tasks_cache
}

function loadCached(file: string): Record<string, unknown> | null {
  const c = cache()
  let mtime: number
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    c.delete(file)
    return null
  }
  const hit = c.get(file)
  if (hit && hit.mtime === mtime) return hit.data
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  c.set(file, { mtime, data })
  return data
}

export function listTasks(): Record<string, unknown>[] {
  const root = tasksRoot()
  const out: Record<string, unknown>[] = []
  const files = fs.readdirSync(root).filter((n) => n.endsWith('.yaml')).sort()
  for (const name of files) {
    const data = loadCached(path.join(root, name))
    if (data) out.push(data)
  }
  return out
}

export function saveTask(taskId: string, task: Record<string, unknown>): void {
  const file = pathFor(taskId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, yaml.dump(task, { noRefs: true, sortKeys: false }), 'utf8')
  fs.renameSync(tmp, file)
  try {
    cache().set(file, { mtime: fs.statSync(file).mtimeMs, data: task })
  } catch {
    /* ignore */
  }
}

export function deleteTask(taskId: string): boolean {
  const file = pathFor(taskId)
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    fs.unlinkSync(file)
    cache().delete(file)
    return true
  }
  return false
}
