export interface ProviderStatus {
  id: string
  label: string
  kind: 'auth_code' | 'device_code'
  description: string
  connected: boolean
  account_label: string | null
}

export interface StartAuthCode {
  kind: 'auth_code'
  flow_id: string
  auth_url: string
}

export interface StartDeviceCode {
  kind: 'device_code'
  flow_id: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string | null
  interval: number
  expires_at: number
}

export type StartResponse = StartAuthCode | StartDeviceCode

export interface FlowStatus {
  status: 'pending' | 'connected' | 'error' | 'expired'
  error: string | null
  account_label: string | null
}

const API_BASE = ''

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${body}`)
  }
  return res.json() as Promise<T>
}

export async function listProviders(): Promise<ProviderStatus[]> {
  return json(await fetch(`${API_BASE}/api/providers`, { cache: 'no-store' }))
}

export async function startConnect(providerId: string): Promise<StartResponse> {
  return json(
    await fetch(`${API_BASE}/api/providers/${providerId}/connect/start`, { method: 'POST' }),
  )
}

export async function getConnectStatus(providerId: string, flowId: string): Promise<FlowStatus> {
  return json(
    await fetch(
      `${API_BASE}/api/providers/${providerId}/connect/status?flow_id=${encodeURIComponent(flowId)}`,
      { cache: 'no-store' },
    ),
  )
}

export async function disconnectProvider(providerId: string): Promise<{ removed: boolean }> {
  return json(await fetch(`${API_BASE}/api/providers/${providerId}`, { method: 'DELETE' }))
}
