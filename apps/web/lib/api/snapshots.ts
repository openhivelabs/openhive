export async function createSnapshot(teamId: string): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/snapshot`, { method: 'POST' })
  if (!res.ok) throw new Error(`snapshot create ${res.status}`)
}

export async function restoreSnapshot(teamId: string): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/snapshot/restore`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`snapshot restore ${res.status}`)
}

export async function discardSnapshot(teamId: string): Promise<void> {
  await fetch(`/api/teams/${encodeURIComponent(teamId)}/snapshot`, { method: 'DELETE' })
}
