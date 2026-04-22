import { CircleNotch, Package, Sparkle, Upload, Warning, X } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import {
  type FramePreview,
  installFrame,
  parseFrameFile,
  teamFromInstallResult,
} from '@/lib/api/frames'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useAppStore } from '@/lib/stores/useAppStore'
import { PRESETS, type PresetDef } from '@/lib/presets'
import type { Team } from '@/lib/types'
import { Button } from '../ui/Button'

interface NewTeamModalProps {
  open: boolean
  companyId: string | null
  onClose: () => void
}

type Mode = 'picker' | 'nl' | 'frame'

export function NewTeamModal({ open, companyId, onClose }: NewTeamModalProps) {
  const addTeam = useAppStore((s) => s.addTeam)
  const companies = useAppStore((s) => s.companies)
  const [mode, setMode] = useState<Mode>('picker')
  const [nlInput, setNlInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [framePreview, setFramePreview] = useState<FramePreview | null>(null)
  const [frameWarnings, setFrameWarnings] = useState<string[]>([])
  const frameFileInput = useRef<HTMLInputElement>(null)

  useEscapeClose(open && companyId, onClose)

  if (!open || !companyId) return null

  const company = companies.find((c) => c.id === companyId)

  const applyPreset = (p: PresetDef) => {
    addTeam(companyId, p.build())
    reset()
  }

  const applyNl = async () => {
    if (!nlInput.trim() || !company) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/teams/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: nlInput, company_slug: company.slug }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`generate failed (${res.status}): ${body}`)
      }
      const raw = (await res.json()) as Record<string, unknown>
      const team = fromServer(raw)
      addTeam(companyId, team)
      reset()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
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
      // Surface warnings briefly even though the team was created. If the user
      // hits Close, they're gone — that's fine; the team exists and is usable.
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
    setNlInput('')
    setError(null)
    setFramePreview(null)
    setFrameWarnings([])
    if (frameFileInput.current) frameFileInput.current.value = ''
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New team"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={reset}
      onKeyDown={(e) => e.key === 'Escape' && reset()}
    >
      <div
        className="w-[620px] max-w-[94vw] rounded-md bg-white shadow-xl border border-neutral-200"
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

        <div className="px-5 pt-4">
          <div className="inline-flex rounded border border-neutral-200 p-0.5 text-[15px]">
            <button
              type="button"
              onClick={() => setMode('picker')}
              className={
                mode === 'picker'
                  ? 'px-3 py-1 rounded-sm bg-neutral-900 text-white'
                  : 'px-3 py-1 rounded-sm text-neutral-600 hover:bg-neutral-100'
              }
            >
              From preset
            </button>
            <button
              type="button"
              onClick={() => setMode('nl')}
              className={
                mode === 'nl'
                  ? 'px-3 py-1 rounded-sm bg-neutral-900 text-white'
                  : 'px-3 py-1 rounded-sm text-neutral-600 hover:bg-neutral-100'
              }
            >
              From description
            </button>
            <button
              type="button"
              onClick={() => setMode('frame')}
              className={
                mode === 'frame'
                  ? 'px-3 py-1 rounded-sm bg-neutral-900 text-white'
                  : 'px-3 py-1 rounded-sm text-neutral-600 hover:bg-neutral-100'
              }
            >
              From Frame
            </button>
          </div>
        </div>

        {mode === 'picker' && (
          <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p)}
                className="text-left rounded-md border border-neutral-200 bg-white p-4 hover:border-neutral-400 hover:shadow-sm transition-all"
              >
                <div className="text-2xl mb-2">{p.icon}</div>
                <div className="font-semibold text-neutral-900 text-[15px]">{p.name}</div>
                <div className="text-[15px] text-neutral-500 mt-1 leading-relaxed">{p.tagline}</div>
                <div className="text-[14px] text-neutral-400 mt-2">
                  {p.build().agents.length} agents
                </div>
              </button>
            ))}
          </div>
        )}

        {mode === 'frame' && (
          <div className="px-5 py-4 space-y-3">
            <div className="flex items-start gap-2 text-[15px] text-neutral-600 bg-amber-50 border border-amber-200 rounded p-2.5">
              <Package className="w-3.5 h-3.5 mt-0.5 text-amber-600 shrink-0" />
              <div>
                Drop a <code>.openhive-frame.yaml</code> file someone shared with you.
                It packs a team's agents, dashboard, and data schema into one file.
              </div>
            </div>
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
                    · {framePreview.hasDashboard ? 'includes' : 'no'} dashboard
                    layout
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
              <Button variant="ghost" onClick={reset}>
                {frameWarnings.length > 0 ? 'Done' : 'Cancel'}
              </Button>
              {framePreview && frameWarnings.length === 0 && (
                <Button
                  variant="primary"
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

        {mode === 'nl' && (
          <div className="px-5 py-4 space-y-3">
            <div className="flex items-start gap-2 text-[15px] text-neutral-600 bg-amber-50 border border-amber-200 rounded p-2.5">
              <Sparkle className="w-3.5 h-3.5 mt-0.5 text-amber-600 shrink-0" />
              <div>
                Copilot LLM이 설명을 읽고 역할·보고선·시스템 프롬프트를 짜서 YAML로 저장.
              </div>
            </div>
            <textarea
              value={nlInput}
              onChange={(e) => setNlInput(e.target.value)}
              rows={4}
              placeholder="어떤 팀을 만들지 설명. 예: '반도체 2nm GAA 트랜지스터 관련 R&D 팀.'"
              className="w-full px-3 py-2 text-[15px] rounded border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
            />
            {error && (
              <div className="text-[14px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2 whitespace-pre-wrap">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
              <Button variant="primary" onClick={applyNl} disabled={loading || !nlInput.trim()}>
                {loading && <CircleNotch className="w-3.5 h-3.5 animate-spin" />}
                {loading ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function fromServer(t: Record<string, unknown>): Team {
  const rawAgents = (t.agents as Record<string, unknown>[]) ?? []
  const rawEdges = (t.edges as Record<string, unknown>[]) ?? []
  return {
    id: String(t.id ?? ''),
    slug: String(t.slug ?? t.id ?? ''),
    name: String(t.name ?? ''),
    agents: rawAgents.map((a) => ({
      id: String(a.id ?? ''),
      role: String(a.role ?? ''),
      label: String(a.label ?? ''),
      providerId: String(a.provider_id ?? ''),
      model: String(a.model ?? ''),
      systemPrompt: String(a.system_prompt ?? ''),
      skills: (a.skills as string[]) ?? [],
      position: (a.position as { x: number; y: number }) ?? { x: 0, y: 0 },
      maxParallel: Number(a.max_parallel ?? 1) || 1,
    })),
    edges: rawEdges.map((e) => ({
      id: String(e.id ?? ''),
      source: String(e.source ?? ''),
      target: String(e.target ?? ''),
    })),
    entryAgentId: (t.entry_agent_id as string | null) ?? null,
    allowedSkills: (t.allowed_skills as string[]) ?? [],
    limits: (t.limits as { max_tool_rounds_per_turn: number; max_delegation_depth: number } | undefined) ?? {
      max_tool_rounds_per_turn: 8,
      max_delegation_depth: 4,
    },
  }
}
