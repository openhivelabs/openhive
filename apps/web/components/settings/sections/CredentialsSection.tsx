import { Key, Plus, TrashSimple } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import {
  type CredentialMeta,
  addApiKey,
  deleteCredential,
  fetchCredentials,
} from '@/lib/api/credentials'
import { useT } from '@/lib/i18n'

/**
 * Settings → Credentials.
 *
 * Managed vault for API keys referenced by `http` panels (and elsewhere) via
 * `auth_ref`. OAuth-based integrations live under Providers / MCP; this page
 * is the non-OAuth plaintext-ish path where the user pastes a key once and it
 * gets fernet-encrypted on disk. The key value is never returned from the
 * server after save — this page only lists metadata.
 */
function prefillFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const p = new URLSearchParams(window.location.search)
    return p.get('prefill_ref')
  } catch {
    return null
  }
}

export function CredentialsSection() {
  const t = useT()
  const [rows, setRows] = useState<CredentialMeta[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [prefill, setPrefill] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setRows(await fetchCredentials())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void reload()
    const pre = prefillFromUrl()
    if (pre) {
      setPrefill(pre)
      setAdding(true)
    }
  }, [reload])

  const onDelete = async (ref: string) => {
    if (!window.confirm(t('credentials.confirmDelete').replace('{ref}', ref))) return
    try {
      await deleteCredential(ref)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="max-w-[720px] space-y-5">
      <header>
        <h2 className="text-[18px] font-semibold text-neutral-900 dark:text-neutral-100">
          {t('settings.section.credentials')}
        </h2>
        <p className="mt-1 text-[13px] text-neutral-500">
          {t('credentials.description')}
        </p>
      </header>

      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-100 dark:divide-neutral-800 bg-white dark:bg-neutral-900">
        {rows && rows.length === 0 && (
          <div className="p-6 flex flex-col items-center text-center">
            <Key className="w-6 h-6 text-neutral-400 mb-2" />
            <div className="text-[13px] text-neutral-500">{t('credentials.empty')}</div>
          </div>
        )}
        {rows?.map((r) => (
          <div key={r.ref_id} className="flex items-center gap-3 px-3 py-2.5">
            <Key className="w-4 h-4 text-neutral-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[14px] text-neutral-900 dark:text-neutral-100 font-mono">
                {r.ref_id}
              </div>
              <div className="text-[12px] text-neutral-400 truncate">
                {r.label ? `${r.label} · ` : ''}
                {r.kind} · {new Date(r.added_at).toLocaleDateString()}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDelete(r.ref_id)}
              aria-label={t('credentials.delete')}
              className="w-7 h-7 flex items-center justify-center rounded-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
            >
              <TrashSimple className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-[13px] font-medium hover:opacity-90 cursor-pointer"
        >
          <Plus weight="bold" className="w-3.5 h-3.5" />
          {t('credentials.add')}
        </button>
      ) : (
        <AddForm
          initialRefId={prefill ?? ''}
          onCancel={() => {
            setAdding(false)
            setPrefill(null)
          }}
          onAdded={async () => {
            setAdding(false)
            setPrefill(null)
            await reload()
          }}
          onError={setError}
        />
      )}

      {error && (
        <div className="text-[13px] text-red-600 dark:text-red-400">{error}</div>
      )}
    </div>
  )
}

function AddForm({
  onAdded,
  onCancel,
  onError,
  initialRefId,
}: {
  onAdded: () => void
  onCancel: () => void
  onError: (msg: string) => void
  initialRefId?: string
}) {
  const t = useT()
  const [refId, setRefId] = useState(initialRefId ?? '')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    setSubmitting(true)
    try {
      await addApiKey({
        ref_id: refId.trim(),
        value: value.trim(),
        label: label.trim() || undefined,
      })
      onAdded()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const input =
    'w-full px-2 py-1.5 rounded-sm text-[14px] border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-400/60'

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 p-4 space-y-3 bg-white dark:bg-neutral-900">
      <div>
        <label className="block text-[13px] text-neutral-600 dark:text-neutral-300 mb-1">
          {t('credentials.field.refId')} <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={refId}
          onChange={(e) => setRefId(e.target.value)}
          placeholder="openweather"
          className={input}
        />
        <p className="mt-1 text-[11px] text-neutral-400">{t('credentials.field.refId.hint')}</p>
      </div>
      <div>
        <label className="block text-[13px] text-neutral-600 dark:text-neutral-300 mb-1">
          {t('credentials.field.value')} <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="••••••••••••"
          className={input}
          autoComplete="off"
        />
        <p className="mt-1 text-[11px] text-neutral-400">{t('credentials.field.value.hint')}</p>
      </div>
      <div>
        <label className="block text-[13px] text-neutral-600 dark:text-neutral-300 mb-1">
          {t('credentials.field.label')}
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="OpenWeather"
          className={input}
        />
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-sm text-[14px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 cursor-pointer"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          disabled={!refId.trim() || !value.trim() || submitting}
          onClick={submit}
          className="px-3 py-1.5 rounded-sm text-[14px] font-medium bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white cursor-pointer"
        >
          {submitting ? t('common.submitting') : t('credentials.add')}
        </button>
      </div>
    </div>
  )
}
