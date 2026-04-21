export interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  mtime: number
  path: string
}

export interface FileList {
  path: string
  entries: FileEntry[]
}

export interface FileContent {
  path: string
  size: number
  content: string | null
  binary: boolean
  reason?: string
}

export async function listFiles(teamId: string, path = ''): Promise<FileList> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/files${qs}`)
  if (!res.ok) throw new Error(`list files ${res.status}`)
  return (await res.json()) as FileList
}

export async function readFile(teamId: string, path: string): Promise<FileContent> {
  const res = await fetch(
    `/api/teams/${encodeURIComponent(teamId)}/files/read?path=${encodeURIComponent(path)}`,
  )
  if (!res.ok) throw new Error(`read file ${res.status}`)
  return (await res.json()) as FileContent
}
