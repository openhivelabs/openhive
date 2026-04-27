import { Plus, TrashSimple } from '@phosphor-icons/react'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  createMemoNote,
  deleteMemoNote,
  fetchMemos,
  type MemoNote,
  updateMemoNote,
} from '@/lib/api/dashboards'
import { useT } from '@/lib/i18n'

/** Multi-note memo panel.
 *
 *  Each note is its own card with its own markdown content. Click a card
 *  to edit its content; the bottom-right "+" FAB adds a fresh empty note
 *  (immediately enters edit mode). Notes are reorderable via drag-and-
 *  drop; release-position becomes the midpoint of neighbours' sort_order
 *  values so existing rows aren't renumbered. */
export function MemoView({ panelId, teamId }: { panelId: string; teamId?: string }) {
  const t = useT()
  const [notes, setNotes] = useState<MemoNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!teamId) return
    let cancelled = false
    fetchMemos(teamId, panelId)
      .then((rows) => {
        if (cancelled) return
        setNotes(rows)
        setLoaded(true)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [teamId, panelId])

  useEffect(() => {
    if (editingId) textareaRef.current?.focus()
  }, [editingId])

  const startEdit = (note: MemoNote) => {
    if (!teamId) return
    setDraft(note.content)
    setEditingId(note.note_id)
    setError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft('')
    setError(null)
  }

  const saveEdit = async () => {
    if (!teamId || !editingId) return
    setSaving(true)
    setError(null)
    try {
      const row = await updateMemoNote(teamId, panelId, editingId, { content: draft })
      setNotes((ns) => ns.map((n) => (n.note_id === row.note_id ? row : n)))
      setEditingId(null)
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const addNote = async () => {
    if (!teamId) return
    setError(null)
    try {
      const row = await createMemoNote(teamId, panelId, '')
      setNotes((ns) => [...ns, row])
      setDraft('')
      setEditingId(row.note_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const removeNote = async (noteId: string) => {
    if (!teamId) return
    setError(null)
    try {
      await deleteMemoNote(teamId, panelId, noteId)
      setNotes((ns) => ns.filter((n) => n.note_id !== noteId))
      if (editingId === noteId) cancelEdit()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const commitReorder = async (noteId: string, dropIndex: number) => {
    if (!teamId) return
    const others = notes.filter((n) => n.note_id !== noteId)
    const orders = others.map((n) => n.sort_order)
    const idx = Math.max(0, Math.min(others.length, dropIndex))
    let newSortOrder: number
    if (others.length === 0) newSortOrder = 1
    else if (idx === 0) newSortOrder = orders[0]! - 1
    else if (idx === others.length) newSortOrder = orders[others.length - 1]! + 1
    else newSortOrder = (orders[idx - 1]! + orders[idx]!) / 2
    // Optimistic local reorder so the card doesn't snap back while the
    // PATCH is in flight.
    setNotes((ns) => {
      const next = ns.map((n) =>
        n.note_id === noteId ? { ...n, sort_order: newSortOrder } : n,
      )
      next.sort((a, b) => a.sort_order - b.sort_order)
      return next
    })
    try {
      await updateMemoNote(teamId, panelId, noteId, { sort_order: newSortOrder })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Refetch on failure so the UI reflects truth.
      try {
        const rows = await fetchMemos(teamId, panelId)
        setNotes(rows)
      } catch {
        /* swallow */
      }
    }
  }

  if (!loaded) return null

  return (
    <div className="h-full w-full overflow-y-auto p-3 space-y-2 relative">
      {notes.length === 0 && editingId == null && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px] text-neutral-400 pointer-events-none">
          {t('memo.empty')}
        </div>
      )}
      {notes.map((note, i) => {
        const showInsertLine =
          dragId &&
          dragId !== note.note_id &&
          hoverIndex === i
        const isEditing = editingId === note.note_id
        return (
          <div key={note.note_id}>
            {showInsertLine && (
              <div className="h-0.5 -my-0.5 bg-amber-400 rounded-full" />
            )}
            <div
              draggable={!isEditing && teamId != null}
              onDragStart={(e) => {
                if (isEditing) return
                e.stopPropagation()
                e.dataTransfer.effectAllowed = 'move'
                setDragId(note.note_id)
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === note.note_id) return
                e.preventDefault()
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                const above = e.clientY < rect.top + rect.height / 2
                const idx = above ? i : i + 1
                if (hoverIndex !== idx) setHoverIndex(idx)
              }}
              onDrop={(e) => {
                if (!dragId) return
                e.preventDefault()
                e.stopPropagation()
                const id = dragId
                const idx = hoverIndex ?? i
                setDragId(null)
                setHoverIndex(null)
                if (id !== note.note_id) void commitReorder(id, idx)
              }}
              onDragEnd={() => {
                setDragId(null)
                setHoverIndex(null)
              }}
              className={clsx(
                'group rounded-sm border bg-white dark:bg-neutral-900 transition-shadow',
                isEditing
                  ? 'border-neutral-300 dark:border-neutral-600 shadow-sm'
                  : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700',
                dragId === note.note_id && 'opacity-40',
              )}
            >
              {isEditing ? (
                <div className="p-2 flex flex-col gap-2">
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={t('memo.placeholder')}
                    className="w-full min-h-[120px] resize-y rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-2 text-[14px] text-neutral-800 dark:text-neutral-100 outline-none focus:border-neutral-400 dark:focus:border-neutral-500 font-mono"
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault()
                        void saveEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelEdit()
                      }
                    }}
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={saving}
                      className="px-2 py-1 rounded-sm text-[12px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
                    >
                      {t('memo.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveEdit()}
                      disabled={saving}
                      className="px-2 py-1 rounded-sm text-[12px] bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 cursor-pointer disabled:opacity-50"
                    >
                      {t('memo.save')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => startEdit(note)}
                  className="w-full text-left p-3 cursor-text bg-transparent relative"
                  title={teamId ? t('memo.editHint') : undefined}
                >
                  {note.content.trim().length === 0 ? (
                    <span className="text-[13px] text-neutral-400 dark:text-neutral-500 italic">
                      {t('memo.empty')}
                    </span>
                  ) : (
                    <div className="prose prose-sm dark:prose-invert max-w-none text-[14px] text-neutral-800 dark:text-neutral-100">
                      <Markdown remarkPlugins={[remarkGfm]}>{note.content}</Markdown>
                    </div>
                  )}
                  <span
                    role="button"
                    aria-label={t('memo.delete')}
                    title={t('memo.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeNote(note.note_id)
                    }}
                    className="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded-sm text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <TrashSimple className="w-3.5 h-3.5" />
                  </span>
                </button>
              )}
            </div>
          </div>
        )
      })}
      {dragId && hoverIndex === notes.length && (
        <div className="h-0.5 bg-amber-400 rounded-full" />
      )}
      {error && (
        <div className="text-[12px] text-red-600 dark:text-red-300 truncate">{error}</div>
      )}
      {teamId && (
        <button
          type="button"
          onClick={() => void addNote()}
          title={t('memo.add')}
          aria-label={t('memo.add')}
          className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 shadow-md hover:bg-neutral-700 dark:hover:bg-neutral-300 flex items-center justify-center cursor-pointer z-10"
        >
          <Plus className="w-4 h-4" weight="bold" />
        </button>
      )}
    </div>
  )
}
