import { ArrowSquareOut, CheckCircle, CircleNotch, Plugs, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SectionHeader } from '@/components/settings/SettingsShell'
import { Button } from '@/components/ui/Button'
import { useT } from '@/lib/i18n'
import {
  type FlowStatus,
  type ProviderStatus,
  type StartResponse,
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

      {loading && !providers && (
        <div className="flex items-center gap-2 text-[15px] text-neutral-500 py-4">
          <CircleNotch className="w-4 h-4 animate-spin" />
          {t('settings.providers.loading')}
        </div>
      )}

      {flowError && (
        <div className="rounded-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-[15px] px-3 py-2 mb-3">
          {flowError}
        </div>
      )}

      <div className="space-y-3">
        {providers?.map((p) => (
          <ProviderCard
            key={p.id}
            t={t}
            provider={p}
            isActiveFlow={activeFlow?.providerId === p.id}
            flowStatus={activeFlow?.providerId === p.id ? flowStatus : null}
            activeFlow={activeFlow?.providerId === p.id ? activeFlow : null}
            onConnect={() => onConnect(p)}
            onDisconnect={() => onDisconnect(p.id)}
            onCancel={cancelFlow}
          />
        ))}
      </div>
    </>
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
}: {
  t: (k: string, vars?: Record<string, string | number>) => string
  provider: ProviderStatus
  isActiveFlow: boolean
  flowStatus: FlowStatus | null
  activeFlow: ActiveFlow | null
  onConnect: () => void
  onDisconnect: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
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
          <p className="text-[15px] text-neutral-500 mt-1 leading-relaxed">{provider.description}</p>
          {provider.account_label && (
            <p className="text-[14px] text-neutral-400 mt-1 font-mono">{provider.account_label}</p>
          )}
        </div>
        <div className="shrink-0">
          {provider.connected ? (
            <Button variant="outline" size="sm" onClick={onDisconnect}>
              <Trash className="w-3.5 h-3.5" />
              {t('settings.providers.disconnect')}
            </Button>
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
                  Open {activeFlow.verificationUri}
                </a>
                <Button variant="ghost" size="sm" onClick={onCancel}>
                  Cancel
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
