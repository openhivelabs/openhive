import { Button } from '@/components/ui/Button'
import { saveCompany } from '@/lib/api/companies'
import {
  type FramePreview,
  type GalleryEntry,
  installFrame,
  listGallery,
  parseFrameFile,
} from '@/lib/api/frames'
import {
  type FlowStatus,
  type ProviderStatus,
  type StartResponse,
  getConnectStatus,
  listProviders,
  startConnect,
} from '@/lib/api/providers'
import { useT } from '@/lib/i18n'
import { useAppStore } from '@/lib/stores/useAppStore'
import { DEFAULT_LEAD_SYSTEM_PROMPT } from '@/lib/defaults/leadSystemPrompt'
import { DEFAULT_AGENT_SKILLS } from '@/lib/defaults/skills'
import type { Agent, Company, ReportingEdge, Team } from '@/lib/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type Step = 0 | 1 | 2 | 3
type TemplateChoice = 'empty' | 'gallery' | 'frame'

export function Onboarding() {
  const t = useT()
  const navigate = useNavigate()
  const { hydrate } = useAppStore()

  const [step, setStep] = useState<Step>(0)
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [pendingFlow, setPendingFlow] = useState<{
    providerId: string
    flowId: string
    deviceCode?: string | null
    verificationUri?: string | null
  } | null>(null)
  const popupRef = useRef<Window | null>(null)
  const [companyName, setCompanyName] = useState('')
  const [template, setTemplate] = useState<TemplateChoice>('empty')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [frameModal, setFrameModal] = useState<null | 'gallery' | 'import'>(null)

  useEffect(() => {
    if (step !== 1) return
    let cancelled = false
    const poll = async () => {
      try {
        const list = await listProviders()
        if (!cancelled) setProviders(list)
      } catch (err) {
        if (!cancelled) setError(String(err))
      }
    }
    void poll()
    const id = window.setInterval(poll, 3000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [step])

  const closePopup = useCallback(() => {
    try {
      popupRef.current?.close()
    } catch {
      /* cross-origin or already-closed popup; ignore */
    }
    popupRef.current = null
  }, [])

  useEffect(() => {
    if (!pendingFlow) return
    let cancelled = false
    const tick = async () => {
      try {
        const status: FlowStatus = await getConnectStatus(
          pendingFlow.providerId,
          pendingFlow.flowId,
        )
        if (cancelled) return
        if (status.status === 'connected') {
          setPendingFlow(null)
          closePopup()
          setProviders((prev) =>
            prev
              ? prev.map((p) =>
                  p.id === pendingFlow.providerId
                    ? { ...p, connected: true, account_label: status.account_label }
                    : p,
                )
              : prev,
          )
        } else if (status.status === 'error' || status.status === 'expired') {
          setPendingFlow(null)
          closePopup()
          setError(status.error || t('onboarding.provider.failed'))
        }
      } catch (err) {
        if (!cancelled) {
          setPendingFlow(null)
          setError(String(err))
        }
      }
    }
    const id = window.setInterval(tick, 1500)
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [pendingFlow, t, closePopup])

  const anyConnected = useMemo(() => (providers ?? []).some((p) => p.connected), [providers])

  const handleConnect = useCallback(async (p: ProviderStatus) => {
    setError(null)
    try {
      const res: StartResponse = await startConnect(p.id)
      if (res.kind === 'auth_code') {
        popupRef.current = window.open(res.auth_url, '_blank', 'width=520,height=720')
        setPendingFlow({ providerId: p.id, flowId: res.flow_id })
      } else {
        popupRef.current = window.open(
          res.verification_uri_complete ?? res.verification_uri,
          '_blank',
          'width=520,height=720',
        )
        setPendingFlow({
          providerId: p.id,
          flowId: res.flow_id,
          deviceCode: res.user_code,
          verificationUri: res.verification_uri,
        })
      }
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const finish = useCallback(async () => {
    setCreating(true)
    setError(null)
    try {
      const firstConnected = (providers ?? []).find((p) => p.connected) ?? null
      if (!firstConnected) {
        throw new Error(t('onboarding.provider.required'))
      }
      const company = buildCompanySpec(
        companyName.trim() || 'My company',
        template,
        firstConnected.id,
      )
      await saveCompany(company)
      window.localStorage.setItem('openhive.onboarded', '1')
      await hydrate()
      const firstTeam = company.teams[0]
      if (firstTeam) {
        navigate(`/${company.slug}/${firstTeam.slug}/dashboard`, { replace: true })
      } else {
        navigate(`/${company.slug}`, { replace: true })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(t('onboarding.failed', { reason: message }))
      setCreating(false)
    }
  }, [providers, companyName, template, hydrate, navigate, t])

  const finishWithFrame = useCallback(
    async (frame: unknown): Promise<{ warnings: string[] }> => {
      setCreating(true)
      setError(null)
      const name = companyName.trim() || 'My company'
      const companyId = `c-${randomHex()}`
      const slug = slugify(name)
      try {
        await saveCompany({ id: companyId, slug, name, teams: [] })
        const result = await installFrame(slug, frame)
        const teamSlug = String(result.team.slug ?? '')
        window.localStorage.setItem('openhive.onboarded', '1')
        await hydrate()
        if (teamSlug) {
          navigate(`/${slug}/${teamSlug}/dashboard`, { replace: true })
        } else {
          navigate(`/${slug}`, { replace: true })
        }
        return { warnings: result.warnings }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(t('onboarding.failed', { reason: message }))
        setCreating(false)
        throw err
      }
    },
    [companyName, hydrate, navigate, t],
  )

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-6">
      <div className="w-full max-w-[520px] bg-white rounded-lg border border-neutral-200 shadow-sm p-8">
        {step > 0 && (
          <div className="text-[12px] text-neutral-400 mb-6 flex items-center justify-between">
            <span>{t('onboarding.step', { n: step, total: 3 })}</span>
            <div className="flex gap-1">
              {[1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={`h-1 w-8 rounded-full ${i <= step ? 'bg-amber-400' : 'bg-neutral-200'}`}
                />
              ))}
            </div>
          </div>
        )}

        {step === 0 && <StepWelcome onNext={() => setStep(1)} />}
        {step === 1 && (
          <StepProvider
            providers={providers}
            pendingFlow={pendingFlow}
            error={error}
            onConnect={handleConnect}
            onBack={() => setStep(0)}
            onNext={async () => {
              setError(null)
              try {
                const fresh = await listProviders()
                setProviders(fresh)
                if (!fresh.some((p) => p.connected)) {
                  setError(t('onboarding.provider.required'))
                  return
                }
              } catch (err) {
                setError(String(err))
                return
              }
              setStep(2)
            }}
            anyConnected={anyConnected}
          />
        )}
        {step === 2 && (
          <StepCompany
            name={companyName}
            setName={setCompanyName}
            error={error}
            onBack={() => setStep(1)}
            onNext={() => {
              const trimmed = companyName.trim()
              if (!trimmed || trimmed.length > 50) {
                setError(t('onboarding.company.invalid'))
                return
              }
              setError(null)
              setStep(3)
            }}
          />
        )}
        {step === 3 && (
          <StepTemplate
            template={template}
            setTemplate={setTemplate}
            creating={creating}
            error={error}
            onBack={() => setStep(2)}
            onFinish={finish}
            onOpenGallery={() => setFrameModal('gallery')}
            onOpenImport={() => setFrameModal('import')}
          />
        )}
      </div>

      {frameModal === 'gallery' && (
        <FrameGalleryModal
          creating={creating}
          onClose={() => setFrameModal(null)}
          onSelect={async (entry) => {
            try {
              await finishWithFrame(entry.frame)
            } catch {
              /* error surfaced via page-level error state */
            }
          }}
        />
      )}
      {frameModal === 'import' && (
        <FrameImportModal
          creating={creating}
          onClose={() => setFrameModal(null)}
          onInstall={async (frameRaw) => {
            try {
              await finishWithFrame(frameRaw)
            } catch {
              /* error surfaced via page-level error state */
            }
          }}
        />
      )}
    </div>
  )
}

function StepWelcome({ onNext }: { onNext: () => void }) {
  const t = useT()
  return (
    <>
      <h1 className="text-[26px] font-semibold text-neutral-900 leading-tight">
        {t('onboarding.welcome.title')}
      </h1>
      <p className="mt-3 text-[14px] text-neutral-600 leading-relaxed">
        {t('onboarding.welcome.subtitle')}
      </p>
      <div className="mt-8 flex justify-end">
        <Button variant="primary" onClick={onNext}>
          {t('onboarding.welcome.start')} →
        </Button>
      </div>
    </>
  )
}

function StepProvider({
  providers,
  pendingFlow,
  error,
  onConnect,
  onBack,
  onNext,
  anyConnected,
}: {
  providers: ProviderStatus[] | null
  pendingFlow: {
    providerId: string
    flowId: string
    deviceCode?: string | null
    verificationUri?: string | null
  } | null
  error: string | null
  onConnect: (p: ProviderStatus) => void
  onBack: () => void
  onNext: () => void | Promise<void>
  anyConnected: boolean
}) {
  const t = useT()
  return (
    <>
      <h1 className="text-[22px] font-semibold text-neutral-900">
        {t('onboarding.provider.title')}
      </h1>
      <p className="mt-2 text-[13.5px] text-neutral-600 leading-relaxed">
        {t('onboarding.provider.subtitle')}
      </p>

      {pendingFlow?.deviceCode && (
        <div className="mt-5 rounded border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="text-[12px] text-neutral-600">{t('onboarding.provider.deviceHint')}</div>
          <div className="mt-1 flex items-center gap-3">
            <span className="font-mono text-[22px] tracking-wider text-neutral-900 select-all">
              {pendingFlow.deviceCode}
            </span>
            <button
              type="button"
              onClick={() => {
                if (pendingFlow.deviceCode) {
                  void navigator.clipboard.writeText(pendingFlow.deviceCode)
                }
              }}
              className="text-[12px] underline text-neutral-600 hover:text-neutral-900"
            >
              {t('onboarding.provider.copy')}
            </button>
          </div>
          {pendingFlow.verificationUri && (
            <div className="mt-2 text-[12px] text-neutral-600">
              {t('onboarding.provider.deviceVisit')}{' '}
              <a
                href={pendingFlow.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="underline text-blue-700"
              >
                {pendingFlow.verificationUri}
              </a>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 space-y-2">
        {!providers && (
          <div className="text-[13px] text-neutral-400 py-4">{t('onboarding.provider.empty')}</div>
        )}
        {providers?.map((p) => {
          const isPending = pendingFlow?.providerId === p.id
          return (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5 rounded border border-neutral-200 bg-white"
            >
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-neutral-800">{p.label}</div>
                <div className="text-[12px] text-neutral-500 truncate">
                  {p.connected
                    ? `${t('onboarding.provider.connected')}${
                        p.account_label ? ` · ${p.account_label}` : ''
                      }`
                    : p.description}
                </div>
              </div>
              {p.connected ? (
                <span className="text-[12px] text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-sm">
                  ✓ {t('onboarding.provider.connected')}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant={isPending ? 'outline' : 'primary'}
                  disabled={isPending}
                  onClick={() => onConnect(p)}
                >
                  {isPending ? t('onboarding.provider.waiting') : t('onboarding.provider.connect')}
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {error && (
        <div className="mt-4 text-[12.5px] text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded">
          {error}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          ← {t('onboarding.back')}
        </Button>
        <Button
          variant="primary"
          onClick={() => void onNext()}
          title={anyConnected ? undefined : t('onboarding.provider.required')}
        >
          {t('onboarding.next')} →
        </Button>
      </div>
    </>
  )
}

function StepCompany({
  name,
  setName,
  error,
  onBack,
  onNext,
}: {
  name: string
  setName: (v: string) => void
  error: string | null
  onBack: () => void
  onNext: () => void
}) {
  const t = useT()
  return (
    <>
      <h1 className="text-[22px] font-semibold text-neutral-900">
        {t('onboarding.company.title')}
      </h1>
      <p className="mt-2 text-[13.5px] text-neutral-600 leading-relaxed">
        {t('onboarding.company.subtitle')}
      </p>

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onNext()
        }}
        placeholder={t('onboarding.company.placeholder')}
        className="mt-6 w-full px-3 py-2.5 rounded border border-neutral-300 text-[15px] focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
        maxLength={50}
      />

      {error && <div className="mt-3 text-[12.5px] text-red-600">{error}</div>}

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          ← {t('onboarding.back')}
        </Button>
        <Button variant="primary" onClick={onNext}>
          {t('onboarding.next')} →
        </Button>
      </div>
    </>
  )
}

function StepTemplate({
  template,
  setTemplate,
  creating,
  error,
  onBack,
  onFinish,
  onOpenGallery,
  onOpenImport,
}: {
  template: TemplateChoice
  setTemplate: (t: TemplateChoice) => void
  creating: boolean
  error: string | null
  onBack: () => void
  onFinish: () => void
  onOpenGallery: () => void
  onOpenImport: () => void
}) {
  const t = useT()
  return (
    <>
      <h1 className="text-[22px] font-semibold text-neutral-900">
        {t('onboarding.template.title')}
      </h1>
      <p className="mt-2 text-[13.5px] text-neutral-600 leading-relaxed">
        {t('onboarding.template.subtitle')}
      </p>

      <div className="mt-6 space-y-2">
        <button
          type="button"
          disabled={creating}
          onClick={() => setTemplate('empty')}
          className={`w-full text-left px-3 py-3 rounded border transition-colors ${
            template === 'empty'
              ? 'border-amber-400 bg-amber-50'
              : 'border-neutral-200 bg-white hover:border-neutral-400'
          }`}
        >
          <div className="text-[14px] font-medium text-neutral-800">
            {t('onboarding.template.empty.title')}
          </div>
          <div className="text-[12.5px] text-neutral-500 mt-0.5">
            {t('onboarding.template.empty.desc')}
          </div>
        </button>

        <button
          type="button"
          disabled={creating}
          onClick={onOpenGallery}
          className="w-full text-left px-3 py-3 rounded border border-neutral-200 bg-white hover:border-neutral-400 transition-colors"
        >
          <div className="text-[14px] font-medium text-neutral-800">
            {t('onboarding.template.gallery.title')}
          </div>
          <div className="text-[12.5px] text-neutral-500 mt-0.5">
            {t('onboarding.template.gallery.desc')}
          </div>
        </button>

        <button
          type="button"
          disabled={creating}
          onClick={onOpenImport}
          className="w-full text-left px-3 py-3 rounded border border-neutral-200 bg-white hover:border-neutral-400 transition-colors"
        >
          <div className="text-[14px] font-medium text-neutral-800">
            {t('onboarding.template.frame.title')}
          </div>
          <div className="text-[12.5px] text-neutral-500 mt-0.5">
            {t('onboarding.template.frame.desc')}
          </div>
        </button>
      </div>

      {error && (
        <div className="mt-4 text-[12.5px] text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded whitespace-pre-wrap">
          {error}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={creating}>
          ← {t('onboarding.back')}
        </Button>
        <Button variant="primary" onClick={onFinish} disabled={creating}>
          {creating ? t('onboarding.creating') : t('onboarding.finish')}
        </Button>
      </div>
    </>
  )
}

function FrameGalleryModal({
  creating,
  onClose,
  onSelect,
}: {
  creating: boolean
  onClose: () => void
  onSelect: (entry: GalleryEntry) => void | Promise<void>
}) {
  const t = useT()
  const [entries, setEntries] = useState<GalleryEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!entries) return null
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => {
      const haystack = [e.name, e.description ?? '', e.id, ...(e.requires?.skills ?? [])]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [entries, query])

  useEffect(() => {
    let cancelled = false
    listGallery()
      .then((list) => {
        if (!cancelled) setEntries(list)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <ModalShell title={t('onboarding.template.gallery.title')} onClose={onClose}>
      {loadError && (
        <div className="text-[13px] text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {loadError}
        </div>
      )}
      {!entries && !loadError && (
        <div className="text-[13px] text-neutral-500 py-6 text-center">
          {t('onboarding.template.gallery.loading')}
        </div>
      )}
      {entries && entries.length === 0 && (
        <div className="text-[13px] text-neutral-500 py-6 text-center">
          {t('onboarding.template.gallery.empty')}
        </div>
      )}
      {entries && entries.length > 0 && (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('onboarding.template.gallery.search')}
            className="w-full px-3 py-2 rounded border border-neutral-300 text-[14px] focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 sticky top-0"
          />
          {filtered && filtered.length === 0 ? (
            <div className="text-[13px] text-neutral-500 py-6 text-center">
              {t('onboarding.template.gallery.noMatch')}
            </div>
          ) : (
            <div className="space-y-2">
              {(filtered ?? entries).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  disabled={creating}
                  onClick={() => void onSelect(e)}
                  className="w-full text-left rounded-md border border-neutral-200 bg-white hover:border-neutral-400 hover:shadow-sm transition-all p-3 disabled:opacity-50"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-[15px] font-semibold text-neutral-900">{e.name}</div>
                    <div className="text-[11.5px] text-neutral-400">v{e.version}</div>
                  </div>
                  {e.description && (
                    <div className="text-[13px] text-neutral-600 mt-1 leading-relaxed">
                      {e.description}
                    </div>
                  )}
                  <div className="text-[12px] text-neutral-500 mt-2">
                    {t('onboarding.template.gallery.agents', { n: e.agent_count })}
                    {e.requires.skills.length > 0 &&
                      ` · ${t('onboarding.template.gallery.skills', { list: e.requires.skills.join(', ') })}`}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </ModalShell>
  )
}

function FrameImportModal({
  creating,
  onClose,
  onInstall,
}: {
  creating: boolean
  onClose: () => void
  onInstall: (frameRaw: unknown) => void | Promise<void>
}) {
  const t = useT()
  const fileInput = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<FramePreview | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  const pickFile = async (file: File | null) => {
    setParseError(null)
    if (!file) return
    try {
      const p = await parseFrameFile(file)
      setPreview(p)
    } catch (err) {
      setPreview(null)
      setParseError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <ModalShell title={t('onboarding.template.frame.title')} onClose={onClose}>
      <input
        ref={fileInput}
        type="file"
        accept=".yaml,.yml,application/x-yaml,text/yaml"
        onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
        className="hidden"
      />
      {!preview && (
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={creating}
          className="w-full border-2 border-dashed border-neutral-300 hover:border-neutral-500 rounded-md py-10 flex flex-col items-center gap-2 text-neutral-500 hover:text-neutral-800 transition-colors disabled:opacity-50"
        >
          <span className="text-[14px] font-medium">{t('onboarding.template.frame.choose')}</span>
          <span className="text-[12px]">.openhive-frame.yaml</span>
        </button>
      )}
      {preview && (
        <div className="rounded-md border border-neutral-200 p-3 space-y-2 text-[13.5px]">
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <div className="text-[15px] font-semibold text-neutral-900">{preview.name}</div>
              <div className="text-[12px] text-neutral-500">
                v{preview.version}
                {preview.description ? ` · ${preview.description}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={creating}
              className="text-[12px] text-neutral-500 hover:text-neutral-900 underline"
            >
              {t('onboarding.template.frame.replace')}
            </button>
          </div>
          <ul className="text-[13px] text-neutral-700 space-y-0.5">
            <li>· {t('onboarding.template.gallery.agents', { n: preview.agentCount })}</li>
            {preview.hasDashboard && <li>· {t('onboarding.template.frame.hasDashboard')}</li>}
            {preview.schemaStatementCount > 0 && (
              <li>
                · {t('onboarding.template.frame.schema', { n: preview.schemaStatementCount })}
              </li>
            )}
            {preview.requires.skills.length > 0 && (
              <li>
                ·{' '}
                {t('onboarding.template.gallery.skills', {
                  list: preview.requires.skills.join(', '),
                })}
              </li>
            )}
          </ul>
        </div>
      )}
      {parseError && (
        <div className="text-[12.5px] text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {parseError}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose} disabled={creating}>
          {t('onboarding.template.frame.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={!preview || creating}
          onClick={() => preview && void onInstall(preview.raw)}
        >
          {creating ? t('onboarding.creating') : t('onboarding.template.frame.install')}
        </Button>
      </div>
    </ModalShell>
  )
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[960px] h-[720px] rounded-md bg-white shadow-xl border border-neutral-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-sm hover:bg-neutral-100 text-neutral-500"
          >
            ✕
          </button>
        </div>
        <div className="p-5 space-y-3 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

function buildCompanySpec(
  companyName: string,
  template: TemplateChoice,
  providerId: string,
): Company {
  const companyId = `c-${randomHex()}`
  const slug = slugify(companyName)

  const leadId = `a-${randomHex()}`
  const defaultModel = defaultModelFor(providerId)

  void template
  const agents: Agent[] = [
    {
      id: leadId,
      role: 'Lead',
      label: 'Lead',
      providerId,
      model: defaultModel,
      systemPrompt: DEFAULT_LEAD_SYSTEM_PROMPT,
      skills: [...DEFAULT_AGENT_SKILLS],
      position: { x: 400, y: 120 },
      maxParallel: 1,
    },
  ]
  const edges: ReportingEdge[] = []
  // Team-level allow-list mirrors the Lead's skills so new members added via
  // canvas inherit the same set (see CreateAgentModal default).
  const allowedSkills: string[] = [...DEFAULT_AGENT_SKILLS]

  const team: Team = {
    id: `t-${randomHex()}`,
    slug: 'main',
    name: 'Main',
    agents,
    edges,
    entryAgentId: leadId,
    allowedSkills,
    allowedMcpServers: [],
    limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
  }

  return { id: companyId, slug, name: companyName, teams: [team] }
}

function randomHex(n = 6): string {
  const bytes = new Uint8Array(Math.ceil(n / 2))
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, n)
}

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
  return base || `company-${randomHex(4)}`
}

function defaultModelFor(providerId: string): string {
  return (
    (
      {
        claude_code: 'claude-opus-4-7',
        anthropic: 'claude-opus-4-7',
        openai: 'gpt-4o',
        codex: 'gpt-4o',
        copilot: 'gpt-4o',
        gemini: 'gemini-2.0-flash',
        ollama: 'llama3.1',
      } as Record<string, string>
    )[providerId] ?? 'default'
  )
}
