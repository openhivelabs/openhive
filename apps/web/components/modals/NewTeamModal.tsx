import {
  ArrowLeft,
  CircleNotch,
  Plus,
  Storefront,
  Upload,
  UploadSimple,
  Warning,
  X,
} from '@phosphor-icons/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type FramePreview,
  installFrame,
  parseFrameFile,
  teamFromInstallResult,
} from '@/lib/api/frames'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useAppStore } from '@/lib/stores/useAppStore'
import { PRESETS } from '@/lib/presets'
import { DEFAULT_TEAM_ICON_KEY, IconPickerButton } from '../shell/TeamIcon'
import { Button } from '../ui/Button'
import { FrameMarketModal } from './FrameMarketModal'

interface NewTeamModalProps {
  open: boolean
  companyId: string | null
  onClose: () => void
}

type Mode = 'picker' | 'empty' | 'frame'

export function NewTeamModal({ open, companyId, onClose }: NewTeamModalProps) {
  const addTeam = useAppStore((s) => s.addTeam)
  const companies = useAppStore((s) => s.companies)
  const [mode, setMode] = useState<Mode>('picker')
  const [marketOpen, setMarketOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [framePreview, setFramePreview] = useState<FramePreview | null>(null)
  const [frameWarnings, setFrameWarnings] = useState<string[]>([])
  const frameFileInput = useRef<HTMLInputElement>(null)
  const [emptyName, setEmptyName] = useState('New Team')
  const [emptyIcon, setEmptyIcon] = useState<string>(DEFAULT_TEAM_ICON_KEY)
  const emptyNameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'empty') {
      const el = emptyNameInput.current
      if (el) {
        el.focus()
        el.select()
      }
    }
  }, [mode])

  useEscapeClose(open && companyId && !marketOpen, onClose)

  if (!open || !companyId) return null

  const company = companies.find((c) => c.id === companyId)

  const applyEmpty = () => {
    const name = emptyName.trim() || 'New Team'
    const base = PRESETS.find((x) => x.id === 'empty-team')?.build()
    if (!base) return
    addTeam(companyId, { ...base, name, icon: emptyIcon })
    reset()
  }

  const onFrameFile = async (file: File | null) => {
    if (!file) return
    setError(null)
    setFrameWarnings([])
    try {
      const preview = await parseFrameFile(file)
      setFramePreview(preview)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setFramePreview(null)
    }
  }

  const applyFrame = async () => {
    if (!framePreview || !company) return
    setLoading(true)
    setError(null)
    try {
      const result = await installFrame(company.slug, framePreview.raw)
      const team = teamFromInstallResult(result.team)
      addTeam(companyId, team)
      if (result.warnings.length > 0) {
        setFrameWarnings(result.warnings)
      } else {
        reset()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const reset = () => {
    setMode('picker')
    setError(null)
    setFramePreview(null)
    setFrameWarnings([])
    setEmptyName('New Team')
    setEmptyIcon(DEFAULT_TEAM_ICON_KEY)
    if (frameFileInput.current) frameFileInput.current.value = ''
    onClose()
  }

  return (
    <>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New team"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={marketOpen ? undefined : reset}
      onKeyDown={(e) => e.key === 'Escape' && !marketOpen && reset()}
    >
      <div
        className="w-[520px] max-w-[94vw] rounded-md bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold">New team</h2>
          <button
            type="button"
            onClick={reset}
            aria-label="Close"
            className="p-1 rounded-sm hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        {mode === 'picker' && (
          <div className="px-5 py-5 space-y-2">
            <PickerRow
              icon={<Plus className="w-5 h-5" />}
              title="Empty"
              desc="Provision a single Lead agent and compose the team manually."
              onClick={() => {
                setEmptyName('New Team')
                setEmptyIcon(DEFAULT_TEAM_ICON_KEY)
                setMode('empty')
              }}
            />
            <PickerRow
              icon={<Storefront className="w-5 h-5" />}
              title="Frame Market"
              desc="Install a curated frame tailored to common workflows."
              onClick={() => setMarketOpen(true)}
            />
            <PickerRow
              icon={<UploadSimple className="w-5 h-5" />}
              title="Import a frame"
              desc="Load a .yaml frame exported from another hive."
              onClick={() => setMode('frame')}
            />
          </div>
        )}

        {mode === 'empty' && (
          <div className="px-5 py-5 space-y-4">
            <button
              type="button"
              onClick={() => setMode('picker')}
              className="inline-flex items-center gap-1 text-[13px] text-neutral-500 hover:text-neutral-900"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <div>
              <div className="text-[15px] font-medium text-neutral-700 mb-2">
                Team name & icon
              </div>
              <div className="flex items-stretch gap-2">
                <IconPickerButton value={emptyIcon} onChange={setEmptyIcon} />
                <input
                  ref={emptyNameInput}
                  value={emptyName}
                  onChange={(e) => setEmptyName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      applyEmpty()
                    }
                  }}
                  placeholder="New Team"
                  className="flex-1 px-3 py-2 text-[15px] rounded-sm border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                />
              </div>
              <p className="text-[13px] text-neutral-500 mt-2">
                Create a new team. Configure members and structure from the team canvas afterwards.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setMode('picker')}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="h-8"
                onClick={applyEmpty}
                disabled={!emptyName.trim()}
              >
                Create team
              </Button>
            </div>
          </div>
        )}

        {mode === 'frame' && (
          <div className="px-5 py-4 space-y-3">
            <button
              type="button"
              onClick={() => setMode('picker')}
              className="inline-flex items-center gap-1 text-[13px] text-neutral-500 hover:text-neutral-900"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <p className="text-[13px] text-neutral-500 leading-relaxed">
              Upload a <code className="font-mono text-neutral-700">.openhive-frame.yaml</code> file shared by
              another hive. A frame bundles the team's agents, dashboard layout, and data schema.
            </p>
            <input
              ref={frameFileInput}
              type="file"
              accept=".yaml,.yml,application/x-yaml,text/yaml"
              onChange={(e) => void onFrameFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            {!framePreview && (
              <button
                type="button"
                onClick={() => frameFileInput.current?.click()}
                className="w-full border-2 border-dashed border-neutral-300 hover:border-neutral-500 rounded-md py-8 flex flex-col items-center gap-2 text-neutral-500 hover:text-neutral-800 transition-colors"
              >
                <Upload className="w-5 h-5" />
                <span className="text-[15px] font-medium">Choose a frame file</span>
                <span className="text-[13px]">.openhive-frame.yaml</span>
              </button>
            )}
            {framePreview && (
              <div className="rounded-md border border-neutral-200 p-3 space-y-2 text-[14px]">
                <div className="flex items-baseline justify-between gap-2">
                  <div>
                    <div className="text-[16px] font-semibold text-neutral-900">
                      {framePreview.name}
                    </div>
                    <div className="text-[13px] text-neutral-500">
                      v{framePreview.version}
                      {framePreview.description ? ` · ${framePreview.description}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => frameFileInput.current?.click()}
                    className="text-[13px] text-neutral-500 hover:text-neutral-900 underline"
                  >
                    Choose different file
                  </button>
                </div>
                <ul className="text-[14px] text-neutral-700 space-y-0.5">
                  <li>· {framePreview.agentCount} agents</li>
                  <li>
                    · {framePreview.hasDashboard ? 'includes' : 'no'} dashboard layout
                  </li>
                  <li>
                    · {framePreview.schemaStatementCount} data-schema statement
                    {framePreview.schemaStatementCount === 1 ? '' : 's'}
                  </li>
                  {framePreview.requires.skills.length > 0 && (
                    <li>
                      · requires skills:{' '}
                      <span className="font-mono text-[13px]">
                        {framePreview.requires.skills.join(', ')}
                      </span>
                    </li>
                  )}
                  {framePreview.requires.providers.length > 0 && (
                    <li>
                      · expects providers:{' '}
                      <span className="font-mono text-[13px]">
                        {framePreview.requires.providers.join(', ')}
                      </span>
                    </li>
                  )}
                </ul>
              </div>
            )}
            {frameWarnings.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-[14px] font-medium text-amber-800">
                  <Warning className="w-3.5 h-3.5" />
                  Created with warnings
                </div>
                <ul className="text-[13px] text-amber-900 space-y-0.5 list-disc list-inside">
                  {frameWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && (
              <div className="text-[14px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2 whitespace-pre-wrap">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={reset}>
                {frameWarnings.length > 0 ? 'Done' : 'Cancel'}
              </Button>
              {framePreview && frameWarnings.length === 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  className="h-8"
                  onClick={applyFrame}
                  disabled={loading}
                >
                  {loading && <CircleNotch className="w-3.5 h-3.5 animate-spin" />}
                  {loading ? 'Installing…' : 'Create team'}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

    </div>
    <FrameMarketModal
      open={marketOpen}
      onClose={() => {
        setMarketOpen(false)
        reset()
      }}
      defaultCompanyId={companyId}
      defaultTeamId={null}
      allowedTabs={['team']}
      lockTarget
    />
    </>
  )
}

function PickerRow({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: ReactNode
  title: string
  desc: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-md border border-neutral-200 bg-white px-4 py-3 hover:border-neutral-900 hover:shadow-sm transition-all flex items-start gap-3"
    >
      <div className="text-neutral-500 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-neutral-900">{title}</div>
        <div className="text-[13px] text-neutral-500 mt-0.5 leading-relaxed">{desc}</div>
      </div>
    </button>
  )
}

