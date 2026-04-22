import { deleteTask, listTasks, saveTask } from '@/lib/server/tasks'
import { Hono } from 'hono'

export const tasks = new Hono()

interface SaveTaskBody {
  task?: Record<string, unknown>
}

// GET /api/tasks — list
tasks.get('/', (c) => c.json(listTasks()))

// PUT /api/tasks/:taskId — save
tasks.put('/:taskId', async (c) => {
  const taskId = c.req.param('taskId')
  const body = (await c.req.json().catch(() => ({}))) as SaveTaskBody
  const task = body?.task
  if (!task || typeof task !== 'object') {
    return c.json({ detail: 'task body required' }, 400)
  }
  const bodyId = task.id
  if (typeof bodyId === 'string' && bodyId && bodyId !== taskId) {
    return c.json({ detail: 'task.id mismatch with URL' }, 400)
  }
  if (!task.id) task.id = taskId
  try {
    saveTask(taskId, task)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 400)
  }
  return c.json({ ok: true })
})

// DELETE /api/tasks/:taskId
tasks.delete('/:taskId', (c) => {
  const taskId = c.req.param('taskId')
  try {
    const ok = deleteTask(taskId)
    if (!ok) {
      return c.json({ detail: 'Task not found' }, 404)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 400)
  }
  return c.json({ ok: true })
})
