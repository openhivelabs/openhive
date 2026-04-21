import type { Task } from '@/lib/types'

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch('/api/tasks')
  if (!res.ok) throw new Error(`GET /api/tasks ${res.status}`)
  const data = (await res.json()) as Task[]
  return Array.isArray(data) ? data : []
}

export async function saveTask(task: Task): Promise<void> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  })
  if (!res.ok) throw new Error(`PUT task ${res.status}`)
}

export async function deleteTask(taskId: string): Promise<void> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 404) throw new Error(`DELETE task ${res.status}`)
}
