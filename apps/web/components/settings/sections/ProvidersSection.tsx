import { ArrowSquareOut, CheckCircle, CircleNotch, Plugs, Trash } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SectionHeader } from '@/components/settings/SettingsShell'
import { Button } from '@/components/ui/Button'
import { useT } from '@/lib/i18n'
import {
  type FlowStatus,
  type ProviderStatus,
  type StartResponse,
  connectWithApiKey,
  disconnectProvider,
  getConnectStatus,
  listProviders,
  startConnect,
} from '@/lib/api/providers'

type ActiveFlow =
  | { kind: 'auth_code'; providerId: string; flowId: string; popup: Window | null }
  | {
      kind: 'device_code'
      providerId: string
      flowId: string
      userCode: string
      verificationUri: string
      verificationUriComplete: string | null
    }

export function ProvidersSection() {
  const t = useT()
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeFlow, setActiveFlow] = useState<ActiveFlow | null>(null)
  const [flowStatus, setFlowStatus] = useState<FlowStatus | null>(null)
  const [flowError, setFlowError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setProviders(await listProviders())
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clearPoll = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => () => clearPoll(), [])

  const startPoll = useCallback(
    (providerId: string, flowId: string) => {
      clearPoll()
      pollRef.current = window.setInterval(async () => {
        try {
          const status = await getConnectStatus(providerId, flowId)
          setFlowStatus(status)
          if (
            status.status === 'connected' ||
            status.status === 'error' ||
            status.status === 'expired'
          ) {
            clearPoll()
            await refresh()
            if (status.status === 'connected') {
              setTimeout(() => {
                setActiveFlow(null)
                setFlowStatus(null)
              }, 1200)
            }
          }
        } catch (e) {
          setFlowError(e instanceof Error ? e.message : String(e))
          clearPoll()
        }
      }, 1500)
    },
    [refresh],
  )

  const onConnect = async (provider: ProviderStatus) => {
    setFlowError(null)
    setFlowStatus({ status: 'pending', error: null, account_label: null })
    try {
      const res: StartResponse = await startConnect(provider.id)
      if (res.kind === 'auth_code') {
        const popup = window.open(res.auth_url, 'openhive-oauth', 'width=520,height=720')
        setActiveFlow({
          kind: 'auth_code',
          providerId: provider.id,
          flowId: res.flow_id,
          popup,
        })
      } else {
        setActiveFlow({
          kind: 'device_code',
          providerId: provider.id,
          flowId: res.flow_id,
          userCode: res.user_code,
          verificationUri: res.verification_uri,
          verificationUriComplete: res.verification_uri_complete,
        })
      }
      startPoll(provider.id, res.flow_id)
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : String(e))
      setFlowStatus(null)
    }
  }

  const onDisconnect = async (providerId: string) => {
    try {
      await disconnectProvider(providerId)
      await refresh()
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : String(e))
    }
  }

  const cancelFlow = () => {
    clearPoll()
    setActiveFlow(null)
    setFlowStatus(null)
  }

  return (
    <>
      <SectionHeader
        title={t('settings.providers.header')}
        desc={t('settings.providers.headerDesc')}
      />

      {flowError && (
        <div className="rounded-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-[15px] px-3 py-2 mb-3">
          {flowError}
        </div>
      )}

      {providers && (
        <div className="space-y-8">
          <ProviderGroup
            title={t('settings.providers.groupOauth')}
            desc={t('settings.providers.groupOauthDesc')}
            emptyLabel={t('settings.providers.groupEmpty')}
            items={providers.filter((p) => p.kind === 'auth_code' || p.kind === 'device_code')}
            t={t}
            activeFlow={activeFlow}
            flowStatus={flowStatus}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onCancel={cancelFlow}
            onRefresh={refresh}
          />
          <ProviderGroup
            title={t('settings.providers.groupApiKey')}
            desc={t('settings.providers.groupApiKeyDesc')}
            emptyLabel={t('settings.providers.groupEmpty')}
            items={providers.filter((p) => p.kind === 'api_key')}
            t={t}
            activeFlow={activeFlow}
            flowStatus={flowStatus}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onCancel={cancelFlow}
            onRefresh={refresh}
          />
        </div>
      )}
    </>
  )
}

function ProviderGroup({
  title,
  desc,
  emptyLabel,
  items,
  t,
  activeFlow,
  flowStatus,
  onConnect,
  onDisconnect,
  onCancel,
  onRefresh,
}: {
  title: string
  desc: string
  emptyLabel: string
  items: ProviderStatus[]
  t: (k: string, vars?: Record<string, string | number>) => string
  activeFlow: ActiveFlow | null
  flowStatus: FlowStatus | null
  onConnect: (p: ProviderStatus) => void
  onDisconnect: (id: string) => void
  onCancel: () => void
  onRefresh: () => Promise<void>
}) {
  return (
    <section>
      <header className="mb-3">
        <h2 className="text-[14px] font-semibold text-neutral-700 dark:text-neutral-200 uppercase tracking-wide">
          {title}
        </h2>
        <p className="text-[13px] text-neutral-500 mt-0.5">{desc}</p>
      </header>
      {items.length === 0 ? (
        <div className="text-[13px] text-neutral-400 italic px-3 py-4 rounded-md border border-dashed border-neutral-200 dark:border-neutral-800">
          {emptyLabel}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((p) => (
            <ProviderCard
              key={p.id}
              t={t}
              provider={p}
              isActiveFlow={activeFlow?.providerId === p.id}
              flowStatus={activeFlow?.providerId === p.id ? flowStatus : null}
              activeFlow={activeFlow?.providerId === p.id ? activeFlow : null}
              onConnect={() => onConnect(p)}
              onDisconnect={() => onDisconnect(p.id)}
              onCancel={onCancel}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ApiKeyForm({
  t,
  provider,
  onCancel,
  onSaved,
}: {
  t: (k: string, vars?: Record<string, string | number>) => string
  provider: ProviderStatus
  onCancel: () => void
  onSaved: () => Promise<void> | void
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Vertex AI takes the service-account JSON value (paste content
  // directly — NOT a file path) plus a separate region selector.
  // Region is sent as the credential `label` and read back at request
  // time by `providers/vertex.ts:resolveLocation()`.
  const isVertex = provider.id === 'vertex-ai'
  const [region, setRegion] = useState('global')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!key.trim()) return
    if (isVertex && !region.trim()) return
    setBusy(true)
    setError(null)
    try {
      await connectWithApiKey(
        provider.id,
        key.trim(),
        isVertex ? region.trim() : undefined,
      )
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-800 space-y-2"
    >
      {isVertex ? (
        <>
          <label className="block">
            <span className="block text-[12px] text-neutral-600 dark:text-neutral-400 mb-1">
              {t('settings.providers.vertexJsonLabel')}
            </span>
            <textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t('settings.providers.vertexJsonPlaceholder')}
              rows={5}
              className="w-full px-3 py-2 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[13px] font-mono text-neutral-800 dark:text-neutral-100"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="block text-[12px] text-neutral-600 dark:text-neutral-400 mb-1">
              {t('settings.providers.vertexRegionLabel')}
            </span>
            <input
              type="text"
              list="vertex-region-options"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="global"
              className="w-full h-9 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[13px] font-mono text-neutral-800 dark:text-neutral-100"
            />
            <datalist id="vertex-region-options">
              <option value="global" />
              <option value="us-central1" />
              <option value="us-east1" />
              <option value="us-east4" />
              <option value="us-west1" />
              <option value="us-west4" />
              <option value="europe-west1" />
              <option value="europe-west4" />
              <option value="asia-northeast1" />
              <option value="asia-northeast3" />
              <option value="asia-southeast1" />
            </datalist>
            <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('settings.providers.vertexRegionHint')}
            </p>
          </label>
        </>
      ) : (
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('settings.providers.apiKeyPlaceholder')}
          className="w-full h-9 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[13px] font-mono text-neutral-800 dark:text-neutral-100"
          autoFocus
        />
      )}
      {error && (
        <div className="rounded-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-[13px] px-2 py-1.5">
          {error}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel} disabled={busy}>
          {t('settings.providers.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={busy || !key.trim() || (isVertex && !region.trim())}
        >
          {busy ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <Plugs className="w-3.5 h-3.5" />}
          {t('settings.providers.save')}
        </Button>
      </div>
    </form>
  )
}

const ICON_EXTS = ['svg', 'webp', 'png'] as const

const ICON_SCALE: Record<string, string> = {
  // Source logos that ship with extra inner whitespace — boost to match others.
  codex: 'scale-[1.4]',
  copilot: 'scale-[1.4]',
}

function ProviderIcon({ id, label }: { id: string; label: string }) {
  const [extIdx, setExtIdx] = useState(0)
  const [failed, setFailed] = useState(false)
  return (
    <div className="w-6 h-6 shrink-0 flex items-center justify-center overflow-hidden">
      {failed ? (
        <span className="text-[14px] font-semibold text-neutral-500">{label.slice(0, 1)}</span>
      ) : (
        <img
          src={`/brands/${id}.${ICON_EXTS[extIdx]}`}
          alt=""
          onError={() => {
            if (extIdx + 1 < ICON_EXTS.length) setExtIdx(extIdx + 1)
            else setFailed(true)
          }}
          className={clsx(
            'max-w-full max-h-full object-contain',
            ICON_SCALE[id],
          )}
        />
      )}
    </div>
  )
}

function ProviderCard({
  t,
  provider,
  isActiveFlow,
  flowStatus,
  activeFlow,
  onConnect,
  onDisconnect,
  onCancel,
  onRefresh,
}: {
  t: (k: string, vars?: Record<string, string | number>) => string
  provider: ProviderStatus
  isActiveFlow: boolean
  flowStatus: FlowStatus | null
  activeFlow: ActiveFlow | null
  onConnect: () => void
  onDisconnect: () => void
  onCancel: () => void
  onRefresh: () => Promise<void>
}) {
  const [keyOpen, setKeyOpen] = useState(false)
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 flex items-start gap-3">
          <ProviderIcon id={provider.id} label={provider.label} />
          <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-900 dark:text-neutral-100">
              {provider.label}
            </span>
            {provider.connected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[14px] px-2 py-0.5 font-medium">
                <CheckCircle weight="fill" className="w-3 h-3" />
                {t('settings.providers.connected')}
              </span>
            )}
          </div>
          </div>
        </div>
        <div className="shrink-0">
          {provider.connected ? (
            <Button variant="outline" size="sm" onClick={onDisconnect}>
              <Trash className="w-3.5 h-3.5" />
              {t('settings.providers.disconnect')}
            </Button>
          ) : provider.kind === 'api_key' ? (
            !keyOpen && (
              <Button variant="primary" size="sm" onClick={() => setKeyOpen(true)}>
                <Plugs className="w-3.5 h-3.5" />
                {t('settings.providers.connect')}
              </Button>
            )
          ) : (
            !isActiveFlow && (
              <Button variant="primary" size="sm" onClick={onConnect}>
                <Plugs className="w-3.5 h-3.5" />
                {t('settings.providers.connect')}
              </Button>
            )
          )}
        </div>
      </div>

      {provider.kind === 'api_key' && keyOpen && !provider.connected && (
        <ApiKeyForm
          t={t}
          provider={provider}
          onCancel={() => setKeyOpen(false)}
          onSaved={async () => {
            setKeyOpen(false)
            await onRefresh()
          }}
        />
      )}

      {isActiveFlow && activeFlow && (
        <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-800">
          {activeFlow.kind === 'auth_code' && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[15px] text-neutral-600 dark:text-neutral-300">
                <CircleNotch className="w-4 h-4 animate-spin text-amber-500" />
                {flowStatus?.status === 'connected'
                  ? t('settings.providers.connectedToast')
                  : t('settings.providers.waitingBrowser')}
              </div>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                {t('settings.providers.cancel')}
              </Button>
            </div>
          )}

          {activeFlow.kind === 'device_code' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[15px] text-neutral-600 dark:text-neutral-300">
                <CircleNotch className="w-4 h-4 animate-spin text-amber-500" />
                {flowStatus?.status === 'connected'
                  ? t('settings.providers.connectedToast')
                  : t('settings.providers.waitingGithub')}
              </div>
              <div className="rounded-sm bg-neutral-900 dark:bg-neutral-800 text-white px-4 py-3 font-mono text-2xl tracking-[0.4em] text-center">
                {activeFlow.userCode}
              </div>
              <div className="flex items-center justify-between gap-2">
                <a
                  href={activeFlow.verificationUriComplete ?? activeFlow.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[15px] text-neutral-900 dark:text-neutral-100 hover:underline"
                >
                  <ArrowSquareOut className="w-3.5 h-3.5" />
                  {t('oauth.openLink', { uri: activeFlow.verificationUri })}
                </a>
                <Button variant="ghost" size="sm" onClick={onCancel}>
                  {t('settings.providers.cancel')}
                </Button>
              </div>
            </div>
          )}

          {flowStatus?.error && (
            <div className="mt-2 rounded-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-[15px] px-2 py-1.5">
              {flowStatus.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
