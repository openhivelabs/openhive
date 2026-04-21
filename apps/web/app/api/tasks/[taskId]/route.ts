import { NextResponse } from 'next/server'
import { deleteTask, saveTask } from '@/lib/server/tasks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface SaveTaskBody {
  task?: Record<string, unknown>
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await ctx.params
  const body = (await req.json()) as SaveTaskBody
  const task = body?.task
  if (!task || typeof task !== 'object') {
    return NextResponse.json({ detail: 'task body required' }, { status: 400 })
  }
  const bodyId = task.id
  if (typeof bodyId === 'string' && bodyId && bodyId !== taskId) {
    return NextResponse.json(
      { detail: 'task.id mismatch with URL' },
      { status: 400 },
    )
  }
  if (!task.id) task.id = taskId
  try {
    saveTask(taskId, task)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ detail: message }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await ctx.params
  try {
    const ok = deleteTask(taskId)
    if (!ok) {
      return NextResponse.json({ detail: 'Task not found' }, { status: 404 })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ detail: message }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
