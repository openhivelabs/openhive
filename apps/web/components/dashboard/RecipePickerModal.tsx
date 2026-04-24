import { MagnifyingGlass, Package, Warning, X } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import {
  type CatalogResponse,
  type Recipe,
  fetchComposerCatalog,
  installRecipe,
} from '@/lib/api/recipes'
import { useT } from '@/lib/i18n'

/**
 * Recipe picker — the non-AI path for installing a pre-authored panel.
 *
 * Two panes:
 *   left:  searchable grid of recipes, grouped by category
 *   right: details + param form (if any) + "Install" button
 *
 * Recipe requirements (MCP server connected / auth_ref present) are checked
 * against the catalog; if unmet, the install button disables with an
 * explanation so users understand what's missing.
 */
export function RecipePickerModal({
  teamId,
  onClose,
  onInstalled,
}: {
  teamId: string
  onClose: () => void
  onInstalled: () => void
}) {
  const t = useT()
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Recipe | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({})
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchComposerCatalog(teamId)
      .then((c) => !cancelled && setCatalog(c))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [teamId])

  useEffect(() => {
    if (!selected) return
    const init: Record<string, unknown> = {}
    for (const p of selected.params ?? []) init[p.name] = p.default ?? ''
    setParamValues(init)
  }, [selected])

  const filtered = useMemo(() => {
    const all = catalog?.recipes ?? []
    if (!query.trim()) return all
    const q = query.trim().toLowerCase()
    return all.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.label.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q),
    )
  }, [catalog, query])

  const requirementCheck = (r: Recipe): { ok: boolean; missing?: string } => {
    if (!r.requires) return { ok: true }
    if (r.requires.mcp_server) {
      const match = catalog?.mcp_servers.find((s) => s.id === r.requires!.mcp_server)
      if (!match || !match.connected) {
        return { ok: false, missing: `MCP: ${r.requires.mcp_server}` }
      }
    }
    if (r.requires.auth_ref) {
      const match = catalog?.credentials.find((c) => c.ref_id === r.requires!.auth_ref)
      if (!match) {
        return { ok: false, missing: `auth_ref: ${r.requires.auth_ref}` }
      }
    }
    return { ok: true }
  }

  const install = async () => {
    if (!selected) return
    setInstalling(true)
    setError(null)
    try {
      await installRecipe(teamId, selected.id, paramValues)
      onInstalled()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[880px] max-w-[95vw] h-[560px] max-h-[90vh] bg-white dark:bg-neutral-900 rounded-lg shadow-xl border border-neutral-200 dark:border-neutral-800 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-800 flex items-center gap-2">
          <Package className="w-4 h-4 text-neutral-500" />
          <span className="flex-1 text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
            {t('recipes.title')}
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

        <div className="flex-1 min-h-0 flex">
          <div className="w-1/2 min-w-0 border-r border-neutral-100 dark:border-neutral-800 flex flex-col">
            <div className="p-3 border-b border-neutral-100 dark:border-neutral-800">
              <div className="relative">
                <MagnifyingGlass className="w-3.5 h-3.5 text-neutral-400 absolute left-2 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('recipes.search')}
                  className="w-full pl-7 pr-2 py-1.5 rounded-sm text-[14px] border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-400/60"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1">
              {catalog && filtered.length === 0 && (
                <div className="p-4 text-[13px] text-neutral-400">
                  {t('recipes.empty')}
                </div>
              )}
              {filtered.map((r) => {
                const req = requirementCheck(r)
                const isSelected = selected?.id === r.id
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelected(r)}
                    className={clsx(
                      'w-full text-left px-3 py-2 rounded-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer flex items-start gap-2',
                      isSelected && 'bg-amber-50 dark:bg-amber-950/40',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-neutral-900 dark:text-neutral-100 truncate">
                        {r.label}
                      </div>
                      {r.description && (
                        <div className="text-[12px] text-neutral-500 truncate">
                          {r.description}
                        </div>
                      )}
                    </div>
                    {!req.ok && (
                      <Warning
                        className="w-3.5 h-3.5 text-amber-500 mt-1 shrink-0"
                        title={`Missing: ${req.missing}`}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="w-1/2 min-w-0 flex flex-col">
            {selected ? (
              <>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  <div>
                    <div className="text-[16px] font-semibold text-neutral-900 dark:text-neutral-100">
                      {selected.label}
                    </div>
                    <div className="text-[11px] text-neutral-400 font-mono mt-0.5">
                      {selected.id}
                    </div>
                  </div>
                  {selected.description && (
                    <p className="text-[13px] text-neutral-600 dark:text-neutral-300">
                      {selected.description}
                    </p>
                  )}
                  {(() => {
                    const req = requirementCheck(selected)
                    if (req.ok) return null
                    return (
                      <div className="px-3 py-2 rounded-sm bg-amber-50 dark:bg-amber-950/40 text-[13px] text-amber-900 dark:text-amber-200 flex items-start gap-2">
                        <Warning className="w-4 h-4 mt-0.5 shrink-0" />
                        <div>
                          <div className="font-medium">{t('recipes.missing')}</div>
                          <div className="font-mono mt-0.5">{req.missing}</div>
                        </div>
                      </div>
                    )
                  })()}
                  {(selected.params ?? []).map((p) => (
                    <ParamInput
                      key={p.name}
                      param={p}
                      value={paramValues[p.name] ?? ''}
                      onChange={(v) => setParamValues((s) => ({ ...s, [p.name]: v }))}
                    />
                  ))}
                </div>
                <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-end gap-2">
                  {error && (
                    <span className="flex-1 text-[12px] text-red-600 dark:text-red-400 truncate">
                      {error}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1.5 rounded-sm text-[14px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 cursor-pointer"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={installing || !requirementCheck(selected).ok}
                    onClick={install}
                    className="px-3 py-1.5 rounded-sm text-[14px] font-medium bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white cursor-pointer"
                  >
                    {installing ? t('common.submitting') : t('recipes.install')}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[13px] text-neutral-400">
                {t('recipes.pickOne')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ParamInput({
  param,
  value,
  onChange,
}: {
  param: import('@/lib/api/recipes').RecipeParam
  value: unknown
  onChange: (v: unknown) => void
}) {
  const base =
    'w-full px-2 py-1.5 rounded-sm text-[14px] border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-400/60'
  const str = value === undefined || value === null ? '' : String(value)
  const label = (
    <label className="block text-[13px] text-neutral-600 dark:text-neutral-300 mb-1">
      {param.label}
      {param.required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  )
  if (param.type === 'select') {
    return (
      <div>
        {label}
        <select value={str} onChange={(e) => onChange(e.target.value)} className={base}>
          {(param.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    )
  }
  return (
    <div>
      {label}
      <input
        type={param.type === 'number' ? 'number' : 'text'}
        value={str}
        onChange={(e) =>
          onChange(param.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)
        }
        className={base}
      />
    </div>
  )
}
