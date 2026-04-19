'use client'

import { ArrowSquareOut, CheckCircle, CircleNotch, Plugs, Trash, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type FlowStatus,
  type ProviderStatus,
  type StartResponse,
  disconnectProvider,
  getConnectStatus,
  listProviders,
  startConnect,
} from '@/lib/api/providers'
import { Button } from '../ui/Button'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

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

export function SettingsModal({ open, onClose }: SettingsModalProps) {
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
    if (open) refresh()
  }, [open, refresh])

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
          if (status.status === 'connected' || status.status === 'error' || status.status === 'expired') {
            clearPoll()
            await refresh()
            if (status.status === 'connected') {
              // Auto-close the flow UI after 1s
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

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[640px] max-w-[96vw] max-h-[88vh] overflow-hidden rounded-2xl bg-white shadow-xl border border-neutral-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <h2 className="text-base font-semibold">Settings · Providers</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {loading && !providers && (
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <CircleNotch className="w-4 h-4 animate-spin" />
              Loading providers…
            </div>
          )}

          {flowError && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">
              {flowError}
            </div>
          )}

          {providers?.map((p) => (
            <ProviderCard
              key={p.id}
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
      </div>
    </div>
  )
}

function ProviderCard({
  provider,
  isActiveFlow,
  flowStatus,
  activeFlow,
  onConnect,
  onDisconnect,
  onCancel,
}: {
  provider: ProviderStatus
  isActiveFlow: boolean
  flowStatus: FlowStatus | null
  activeFlow: ActiveFlow | null
  onConnect: () => void
  onDisconnect: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-900">{provider.label}</span>
            {provider.connected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 text-[11px] px-2 py-0.5 font-medium">
                <CheckCircle weight="fill" className="w-3 h-3" />
                Connected
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-500 mt-1 leading-relaxed">{provider.description}</p>
          {provider.account_label && (
            <p className="text-[11px] text-neutral-400 mt-1 font-mono">{provider.account_label}</p>
          )}
        </div>
        <div className="shrink-0">
          {provider.connected ? (
            <Button variant="outline" size="sm" onClick={onDisconnect}>
              <Trash className="w-3.5 h-3.5" />
              Disconnect
            </Button>
          ) : (
            !isActiveFlow && (
              <Button variant="primary" size="sm" onClick={onConnect}>
                <Plugs className="w-3.5 h-3.5" />
                Connect
              </Button>
            )
          )}
        </div>
      </div>

      {isActiveFlow && activeFlow && (
        <div className="mt-3 pt-3 border-t border-neutral-200">
          {activeFlow.kind === 'auth_code' && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-neutral-600">
                <CircleNotch className="w-4 h-4 animate-spin text-amber-500" />
                {flowStatus?.status === 'connected'
                  ? 'Connected!'
                  : 'Waiting for browser authorization…'}
              </div>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          )}

          {activeFlow.kind === 'device_code' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-neutral-600">
                <CircleNotch className="w-4 h-4 animate-spin text-amber-500" />
                {flowStatus?.status === 'connected'
                  ? 'Connected!'
                  : 'Waiting for you to authorize on GitHub…'}
              </div>
              <div className="rounded-lg bg-neutral-900 text-white px-4 py-3 font-mono text-2xl tracking-[0.4em] text-center">
                {activeFlow.userCode}
              </div>
              <div className="flex items-center justify-between gap-2">
                <a
                  href={activeFlow.verificationUriComplete ?? activeFlow.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-neutral-900 hover:underline"
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
            <div className="mt-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-2 py-1.5">
              {flowStatus.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
