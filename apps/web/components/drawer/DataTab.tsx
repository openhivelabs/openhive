import { Package, Sparkle, Table } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import {
  fetchSchema,
  fetchTableRows,
  installTemplate,
  type QueryResult,
  type SchemaResponse,
} from '@/lib/api/teamData'
import { useT } from '@/lib/i18n'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'

const AVAILABLE_TEMPLATES = ['crm']

export function DataTab() {
  const t = useT()
  const team = useCurrentTeam()
  const teamId = useAppStore((s) => s.currentTeamId)
  const [schema, setSchema] = useState<SchemaResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [rows, setRows] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadSchema = useCallback(async () => {
    if (!teamId) return
    setLoading(true)
    setError(null)
    try {
      const s = await fetchSchema(teamId)
      setSchema(s)
      if (!selected && s.tables.length > 0) setSelected(s.tables[0]!.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [teamId, selected])

  useEffect(() => {
    void loadSchema()
  }, [loadSchema])

  useEffect(() => {
    if (!teamId || !selected) {
      setRows(null)
      return
    }
    fetchTableRows(teamId, selected)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [teamId, selected])

  const onInstall = async (name: string) => {
    if (!teamId) return
    setInstalling(name)
    setError(null)
    try {
      await installTemplate(teamId, name)
      await loadSchema()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(null)
    }
  }

  const hasTables = schema && schema.tables.length > 0

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-neutral-200">
        <div className="flex items-center gap-2 text-[15px] text-neutral-700 mb-0.5">
          <Table className="w-4 h-4 text-neutral-500" />
          <span className="font-medium">{t('data.title', { name: team?.name ?? 'Team' })}</span>
        </div>
        <p className="text-[14px] text-neutral-500">{t('data.subtitle')}</p>
      </div>

      {error && (
        <div className="mx-3 mt-3 rounded border border-red-200 bg-red-50 text-red-700 text-[14px] px-2.5 py-2">
          {error}
        </div>
      )}

      {!hasTables && (
        <div className="px-3 py-3 space-y-3 overflow-y-auto">
          <div className="rounded border border-dashed border-neutral-300 bg-neutral-50 p-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-sm bg-white border border-neutral-200 flex items-center justify-center">
                <Package className="w-4 h-4 text-neutral-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-medium text-neutral-800">{t('data.noTemplate')}</div>
                <p className="text-[15px] text-neutral-500 mt-1 leading-relaxed">
                  {t('data.noTemplateBody')}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {AVAILABLE_TEMPLATES.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => onInstall(name)}
                      disabled={installing !== null}
                      className="px-2.5 py-1 rounded-sm bg-white border border-neutral-300 text-[14px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 cursor-pointer"
                    >
                      {installing === name ? `Installing ${name}…` : `Install ${name}`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded bg-amber-50 border border-amber-200 p-3">
            <div className="flex items-center gap-2 text-[15px] text-amber-800 font-medium">
              <Sparkle className="w-3.5 h-3.5" />
              {t('data.previewTitle')}
            </div>
            <p className="text-[14px] text-amber-700 mt-1 leading-relaxed">
              {t('data.previewBody')}
            </p>
          </div>
        </div>
      )}

      {hasTables && (
        <div className="flex-1 flex min-h-0">
          <div className="w-[140px] shrink-0 border-r border-neutral-200 overflow-y-auto">
            {schema!.tables.map((tbl) => (
              <button
                key={tbl.name}
                type="button"
                onClick={() => setSelected(tbl.name)}
                className={
                  selected === tbl.name
                    ? 'w-full text-left px-3 py-2 text-[15px] bg-amber-50 text-amber-900 border-l-2 border-amber-500 cursor-pointer'
                    : 'w-full text-left px-3 py-2 text-[15px] text-neutral-700 hover:bg-neutral-50 border-l-2 border-transparent cursor-pointer'
                }
              >
                <div className="font-medium truncate">{tbl.name}</div>
                <div className="text-[14px] text-neutral-400 font-mono">{tbl.row_count} rows</div>
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-auto">
            {rows && rows.columns.length > 0 ? (
              <table className="w-full text-[14px]">
                <thead className="bg-neutral-50 sticky top-0">
                  <tr>
                    {rows.columns.map((c) => (
                      <th key={c} className="text-left font-medium text-neutral-600 px-2 py-1.5 border-b border-neutral-200 whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.rows.length === 0 ? (
                    <tr>
                      <td colSpan={rows.columns.length} className="text-center text-neutral-400 px-2 py-4">
                        no rows
                      </td>
                    </tr>
                  ) : (
                    rows.rows.map((row, i) => (
                      <tr key={i} className="hover:bg-neutral-50">
                        {rows.columns.map((c) => (
                          <td
                            key={c}
                            className="px-2 py-1 border-b border-neutral-100 text-neutral-800 font-mono whitespace-nowrap max-w-[220px] truncate"
                            title={String(row[c] ?? '')}
                          >
                            {formatCell(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            ) : (
              <div className="p-3 text-[14px] text-neutral-400">…</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
