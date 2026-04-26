import { CaretDown, CaretRight, CircleNotch } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { PanelBinding } from '@/lib/api/dashboards'
import { previewBinding } from '@/lib/api/panels'
import { useT } from '@/lib/i18n'

/**
 * Collapsible JSON editor for a panel's binding (source.config + map +
 * refresh_seconds). Lets power users tweak the AI-generated SQL / MCP args
 * without re-rounding through the binder, then run a one-shot preview to
 * confirm the edit produces data.
 */
export function BindingCodeEditor({
  binding,
  panelType,
  teamId,
  onChange,
  onPreview,
}: {
  binding: PanelBinding | null
  panelType: string
  teamId: string | null
  onChange: (next: PanelBinding) => void
  onPreview?: (data: unknown) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(() => stringify(binding))
  const [parseError, setParseError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  // Re-sync the textarea whenever the binding changes from outside (e.g. user
  // clicked Apply and the AI rebound). Skip while the user has invalid JSON
  // in flight so we don't clobber their in-progress edit on an unrelated
  // re-render.
  useEffect(() => {
    if (parseError) return
    setText(stringify(binding))
  }, [binding, parseError])

  const onTextChange = (next: string) => {
    setText(next)
    if (next.trim() === '') {
      setParseError(null)
      return
    }
    try {
      const parsed = JSON.parse(next) as PanelBinding
      setParseError(null)
      onChange(parsed)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e))
    }
  }

  const onRun = async () => {
    if (!teamId || parseError) return
    let parsed: PanelBinding
    try {
      parsed = JSON.parse(text) as PanelBinding
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e))
      return
    }
    setBusy(true)
    setRunError(null)
    try {
      const r = await previewBinding(
        teamId,
        panelType,
        parsed as unknown as Record<string, unknown>,
      )
      if (r.ok) {
        onPreview?.(r.data)
      } else {
        setRunError(r.error ?? 'preview failed')
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 border border-neutral-200 dark:border-neutral-700 rounded-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
        aria-expanded={open}
      >
        {open ? (
          <CaretDown className="w-3 h-3" />
        ) : (
          <CaretRight className="w-3 h-3" />
        )}
        <span className="font-medium">{t('panel.edit.code')}</span>
      </button>
      {open && (
        <div className="p-2 border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950">
          <textarea
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            spellCheck={false}
            rows={12}
            className="w-full px-2 py-1.5 text-[11.5px] font-mono leading-snug rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300 resize-y"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onRun}
              disabled={busy || !teamId || parseError !== null}
              className="inline-flex items-center justify-center gap-1.5 h-7 px-3 text-[12px] rounded-sm border border-neutral-300 dark:border-neutral-600 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {busy ? <CircleNotch className="w-3 h-3 animate-spin" /> : null}
              {t('panel.edit.codeRun')}
            </button>
            {parseError && (
              <span className="text-[11.5px] text-red-600 dark:text-red-300 font-mono truncate">
                {t('panel.edit.codeInvalid')}: {parseError}
              </span>
            )}
            {runError && !parseError && (
              <span className="text-[11.5px] text-red-600 dark:text-red-300 font-mono truncate">
                {runError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function stringify(binding: PanelBinding | null): string {
  if (!binding) return '{}'
  try {
    return JSON.stringify(binding, null, 2)
  } catch {
    return '{}'
  }
}
