export interface ModelInfo {
  id: string
  label: string
  default: boolean
}

export async function listModels(providerId: string): Promise<ModelInfo[]> {
  const res = await fetch(
    `/api/providers/${encodeURIComponent(providerId)}/models`,
    { cache: 'no-store' },
  )
  if (!res.ok) throw new Error(`models fetch failed (${res.status})`)
  return (await res.json()) as ModelInfo[]
}
