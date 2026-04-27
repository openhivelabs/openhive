import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchMemo, saveMemo } from '@/lib/api/dashboards'
import { useT } from '@/lib/i18n'

export function MemoView({ panelId, teamId }: { panelId: string; teamId?: string }) {
  const t = useT()
  const [content, setContent] = useState<string>('')
  const [draft, setDraft] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!teamId) return
    let cancelled = false
    fetchMemo(teamId, panelId)
      .then((row) => {
        if (cancelled) return
        setContent(row.content)
        setDraft(row.content)
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
    if (editing) textareaRef.current?.focus()
  }, [editing])

  const startEdit = () => {
    if (!teamId) return
    setDraft(content)
    setEditing(true)
  }

  const save = async () => {
    if (!teamId) return
    setSaving(true)
    setError(null)
    try {
      const row = await saveMemo(teamId, panelId, draft)
      setContent(row.content)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setDraft(content)
    setEditing(false)
    setError(null)
  }

  if (!loaded) return null

  if (editing) {
    return (
      <div className="h-full flex flex-col p-2 gap-2">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('memo.placeholder')}
          className="flex-1 min-h-0 w-full resize-none rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-2 text-[14px] text-neutral-800 dark:text-neutral-100 outline-none focus:border-neutral-400 dark:focus:border-neutral-500 font-mono"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
        />
        {error && (
          <div className="text-[12px] text-red-600 dark:text-red-300 truncate">{error}</div>
        )}
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            className="px-2 py-1 rounded-sm text-[12px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
          >
            {t('memo.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="px-2 py-1 rounded-sm text-[12px] bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 cursor-pointer disabled:opacity-50"
          >
            {t('memo.save')}
          </button>
        </div>
      </div>
    )
  }

  const isEmpty = content.trim().length === 0

  return (
    <button
      type="button"
      onClick={startEdit}
      className="h-full w-full text-left p-3 cursor-text bg-transparent"
      title={teamId ? t('memo.editHint') : undefined}
    >
      {isEmpty ? (
        <span className="text-[14px] text-neutral-400 dark:text-neutral-500 italic">
          {t('memo.empty')}
        </span>
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none text-[14px] text-neutral-800 dark:text-neutral-100">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      )}
    </button>
  )
}
