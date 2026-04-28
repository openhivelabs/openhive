type CredentialKind = 'api_key' | 'oauth'

export interface CredentialMeta {
  ref_id: string
  kind: CredentialKind
  provider?: string
  label?: string
  scopes?: string[]
  added_at: number
}

export async function fetchCredentials(): Promise<CredentialMeta[]> {
  const res = await fetch('/api/credentials')
  if (!res.ok) throw new Error(`GET credentials ${res.status}`)
  const data = (await res.json()) as { credentials: CredentialMeta[] }
  return data.credentials
}

export async function addApiKey(input: {
  ref_id: string
  value: string
  label?: string
  scopes?: string[]
}): Promise<CredentialMeta> {
  const res = await fetch('/api/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as {
    credential?: CredentialMeta
    detail?: string
  }
  if (!res.ok) throw new Error(body.detail ?? `POST credentials ${res.status}`)
  if (!body.credential) throw new Error('malformed response')
  return body.credential
}

export async function deleteCredential(refId: string): Promise<void> {
  const res = await fetch(`/api/credentials/${encodeURIComponent(refId)}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 404) throw new Error(`DELETE credentials ${res.status}`)
}
