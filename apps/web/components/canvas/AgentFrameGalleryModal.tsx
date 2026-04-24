import { CircleNotch, Package, Upload, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import {
  type AgentFramePreview,
  type AgentGalleryEntry,
  agentFromInstallResult,
  installAgentFrame,
  listAgentGallery,
  parseAgentFrameFile,
} from '@/lib/api/agent-frames'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import type { Agent } from '@/lib/types'
import { Button } from '../ui/Button'

interface Props {
  open: boolean
  onClose: () => void
  companySlug: string
  teamSlug: string
  onInstalled: (agent: Agent, warnings: string[]) => void
}

export function AgentFrameGalleryModal({
  open,
  onClose,
  companySlug,
  teamSlug,
  onInstalled,
}: Props) {
  const t = useT()
  const [entries, setEntries] = useState<AgentGalleryEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<AgentFramePreview | null>(null)
  const [importing, setImporting] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEscapeClose(open, onClose)

  useEffect(() => {
    if (!open) return
    setEntries(null)
    setLoadError(null)
    setError(null)
    setPreview(null)
    setImporting(false)
    setDragActive(false)
    setInstallingId(null)
    listAgentGallery()
      .then(setEntries)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }, [open])

  if (!open) return null

  const closeAll = () => {
    if (fileInput.current) fileInput.current.value = ''
    onClose()
  }

  const handleFile = async (file: File | null) => {
    if (!file) return
    setError(null)
    try {
      setPreview(await parseAgentFrameFile(file))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPreview(null)
    }
  }

  const installFromPreview = async () => {
    if (!preview) return
    setImporting(true)
    setError(null)
    try {
      const { agent, warnings } = await installAgentFrame(companySlug, teamSlug, preview.raw)
      onInstalled(agentFromInstallResult(agent), warnings)
      closeAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  const handleInstallEntry = async (entry: AgentGalleryEntry) => {
    setInstallingId(entry.id)
    setError(null)
    try {
      const { agent, warnings } = await installAgentFrame(companySlug, teamSlug, entry.frame)
      onInstalled(agentFromInstallResult(agent), warnings)
      closeAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstallingId(null)
    }
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files?.[0] ?? null
    void handleFile(file)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas.frameGalleryTitle')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={closeAll}
      onKeyDown={(e) => e.key === 'Escape' && closeAll()}
    >
      <div
        className="w-[640px] max-w-[94vw] max-h-[86vh] flex flex-col rounded-md bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold flex items-center gap-1.5">
            <Package weight="fill" className="w-4 h-4 text-sky-500" />
            {t('canvas.frameGalleryTitle')}
          </h2>
          <button
            type="button"
            onClick={closeAll}
            aria-label={t('canvas.close')}
            className="p-1 rounded-sm hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {/* --- Drop / pick zone or preview --- */}
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,application/x-yaml,text/yaml"
            onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          {!preview ? (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={onDragOver}
              onDragEnter={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={`w-full border-2 border-dashed rounded-md py-8 flex flex-col items-center gap-2 transition-colors cursor-pointer ${
                dragActive
                  ? 'border-sky-500 bg-sky-50 text-sky-700'
                  : 'border-neutral-300 hover:border-neutral-500 text-neutral-500 hover:text-neutral-800'
              }`}
            >
              <Upload className="w-5 h-5" />
              <span className="text-[14px] font-medium">
                {dragActive ? t('canvas.frameDropActive') : t('canvas.frameDrop')}
              </span>
              <span className="text-[12px]">{t('canvas.frameDropHint')}</span>
            </button>
          ) : (
            <div className="rounded-md border border-neutral-200 p-3 space-y-2 text-[14px]">
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-neutral-900 truncate">
                    {preview.name}
                  </div>
                  <div className="text-[12px] text-neutral-500 flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                    {preview.role && <span>{preview.role}</span>}
                    {preview.providerId && <span>· {preview.providerId}</span>}
                    {preview.model && <span>· {preview.model}</span>}
                    <span>· v{preview.version}</span>
                  </div>
                  {preview.description && (
                    <div className="mt-1.5 text-[13px] text-neutral-600 leading-relaxed">
                      {preview.description}
                    </div>
                  )}
                  {(preview.requires.skills.length > 0 ||
                    preview.requires.providers.length > 0) && (
                    <div className="mt-2 text-[12px] text-neutral-500">
                      <span className="font-medium">{t('canvas.frameRequires')}:</span>{' '}
                      {[...preview.requires.providers, ...preview.requires.skills].join(', ')}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (fileInput.current) fileInput.current.value = ''
                    setPreview(null)
                  }}
                  className="text-[12px] text-neutral-500 hover:text-neutral-900 underline shrink-0"
                >
                  {t('canvas.frameChooseDifferent')}
                </button>
              </div>
              <div className="flex justify-end">
                <Button variant="primary" onClick={installFromPreview} disabled={importing}>
                  {importing && <CircleNotch className="w-3.5 h-3.5 animate-spin" />}
                  {importing ? t('canvas.frameImporting') : t('canvas.frameImport')}
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="text-[14px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2 whitespace-pre-wrap">
              {error}
            </div>
          )}

          {/* --- Gallery --- */}
          <div className="pt-1">
            <div className="text-[12px] font-medium text-neutral-500 uppercase tracking-wide mb-2">
              {t('canvas.frameFromGallery')}
            </div>
            {loadError && (
              <div className="text-[14px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2">
                {loadError}
              </div>
            )}
            {entries && entries.length === 0 && (
              <div className="text-[13px] text-neutral-500 py-4 text-center leading-relaxed">
                {t('canvas.frameGalleryEmpty')}
              </div>
            )}
            <div className="space-y-2">
              {entries?.map((entry) => (
                <div
                  key={entry.id}
                  className="border border-neutral-200 rounded p-3 hover:border-neutral-300 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[14px] font-medium text-neutral-800">{entry.name}</div>
                      <div className="mt-0.5 text-[12px] text-neutral-500 flex flex-wrap gap-x-2 gap-y-0.5">
                        {entry.role && <span>{entry.role}</span>}
                        {entry.provider_id && <span>· {entry.provider_id}</span>}
                        {entry.model && <span>· {entry.model}</span>}
                        <span>· v{entry.version}</span>
                      </div>
                      {entry.description && (
                        <div className="mt-1.5 text-[13px] text-neutral-600 leading-relaxed">
                          {entry.description}
                        </div>
                      )}
                    </div>
                    <Button
                      variant="primary"
                      onClick={() => handleInstallEntry(entry)}
                      disabled={installingId !== null}
                    >
                      {installingId === entry.id ? (
                        <>
                          <CircleNotch className="w-3.5 h-3.5 animate-spin" />
                          {t('canvas.frameInstalling')}
                        </>
                      ) : (
                        t('canvas.frameInstall')
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
