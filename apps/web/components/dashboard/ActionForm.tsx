import { useState } from 'react'
import { Warning, X } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type { FormField, PanelAction } from '@/lib/api/dashboards'
import { executePanelAction } from '@/lib/api/panels'
import { useT } from '@/lib/i18n'

/**
 * Generic form renderer for a panel `create` / `update` / `custom` action.
 * Renders one input per `form.fields[]`, validates client-side, and calls the
 * server-side executor. Delete / irreversible actions use `ConfirmActionButton`
 * below instead of a form.
 */
export function ActionFormModal({
  panelId,
  teamId,
  action,
  initialValues,
  onClose,
  onSuccess,
}: {
  panelId: string
  teamId: string
  action: PanelAction
  initialValues?: Record<string, unknown>
  onClose: () => void
  onSuccess?: () => void
}) {
  const t = useT()
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = { ...(initialValues ?? {}) }
    for (const f of action.form?.fields ?? []) {
      if (out[f.name] === undefined && f.default !== undefined) out[f.name] = f.default
    }
    return out
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setField = (name: string, v: unknown) => setValues((s) => ({ ...s, [name]: v }))

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await executePanelAction(panelId, action.id, teamId, values)
      onSuccess?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[90vw] bg-white dark:bg-neutral-900 rounded-lg shadow-xl border border-neutral-200 dark:border-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-800 flex items-center gap-2">
          <span className="flex-1 text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
            {action.label}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-7 h-7 flex items-center justify-center rounded-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {action.irreversible && (
          <div className="mx-4 mt-3 px-3 py-2 flex items-start gap-2 rounded-sm bg-amber-50 dark:bg-amber-950/40 text-[13px] text-amber-900 dark:text-amber-200">
            <Warning className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{t('action.irreversibleWarning')}</span>
          </div>
        )}
        <div className="p-4 space-y-3">
          {(action.form?.fields ?? []).map((f) => (
            <FieldInput
              key={f.name}
              field={f}
              value={values[f.name]}
              onChange={(v) => setField(f.name, v)}
            />
          ))}
          {error && (
            <div className="text-[13px] text-red-600 dark:text-red-400 whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-sm text-[14px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 cursor-pointer"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className={clsx(
              'px-3 py-1.5 rounded-sm text-[14px] font-medium cursor-pointer',
              action.irreversible || action.kind === 'delete'
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-amber-500 hover:bg-amber-600 text-white',
              submitting && 'opacity-60 cursor-wait',
            )}
          >
            {submitting ? t('common.submitting') : action.label}
          </button>
        </div>
      </div>
    </div>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const base =
    'w-full px-2 py-1.5 rounded-sm text-[14px] border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-400/60'
  const label = (
    <label className="block text-[13px] text-neutral-600 dark:text-neutral-300 mb-1">
      {field.label}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  )
  const str = value === undefined || value === null ? '' : String(value)
  switch (field.type) {
    case 'textarea':
      return (
        <div>
          {label}
          <textarea
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            className={base}
          />
        </div>
      )
    case 'number':
      return (
        <div>
          {label}
          <input
            type="number"
            value={str}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            className={base}
          />
        </div>
      )
    case 'select':
      return (
        <div>
          {label}
          <select
            value={str}
            onChange={(e) => onChange(e.target.value)}
            className={base}
          >
            {(field.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      )
    case 'toggle':
      return (
        <div className="flex items-center gap-2">
          <input
            id={`f-${field.name}`}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <label htmlFor={`f-${field.name}`} className="text-[13px] text-neutral-600 dark:text-neutral-300">
            {field.label}
          </label>
        </div>
      )
    case 'date':
      return (
        <div>
          {label}
          <input type="date" value={str} onChange={(e) => onChange(e.target.value)} className={base} />
        </div>
      )
    case 'datetime':
      return (
        <div>
          {label}
          <input
            type="datetime-local"
            value={str}
            onChange={(e) => onChange(e.target.value)}
            className={base}
          />
        </div>
      )
    default:
      return (
        <div>
          {label}
          <input
            type="text"
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            className={base}
          />
        </div>
      )
  }
}

/**
 * Confirm button for destructive / zero-form actions (e.g. delete a row).
 * Two-step for `irreversible`. Used by BoundPanel row-level buttons.
 */
export async function runConfirmAction(opts: {
  panelId: string
  teamId: string
  action: PanelAction
  values: Record<string, unknown>
  t: (k: string) => string
  onSuccess?: () => void
  onError?: (msg: string) => void
}): Promise<void> {
  const { panelId, teamId, action, values, t } = opts
  if (action.confirm) {
    const msg = action.irreversible
      ? t('action.irreversibleConfirm').replace('{label}', action.label)
      : t('action.confirm').replace('{label}', action.label)
    if (!window.confirm(msg)) return
  }
  try {
    await executePanelAction(panelId, action.id, teamId, values)
    opts.onSuccess?.()
  } catch (e) {
    opts.onError?.(e instanceof Error ? e.message : String(e))
  }
}
