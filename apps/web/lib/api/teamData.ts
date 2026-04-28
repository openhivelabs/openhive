export interface ColumnInfo {
  name: string
  type: string
  notnull: boolean
  pk: boolean
}

interface TableInfo {
  name: string
  columns: ColumnInfo[]
  row_count: number
}

interface MigrationRow {
  id: number
  applied_at: number
  source: string
  sql: string
  note: string | null
}

export interface SchemaResponse {
  tables: TableInfo[]
  recent_migrations: MigrationRow[]
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface PagedQueryResult extends QueryResult {
  total: number
  limit: number
  offset: number
}

export async function fetchSchema(teamId: string): Promise<SchemaResponse> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/schema`)
  if (!res.ok) throw new Error(`GET schema ${res.status}`)
  return (await res.json()) as SchemaResponse
}

export async function fetchTableRows(
  teamId: string,
  table: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<PagedQueryResult> {
  const limit = opts.limit ?? 100
  const offset = opts.offset ?? 0
  const res = await fetch(
    `/api/teams/${encodeURIComponent(teamId)}/table/${encodeURIComponent(table)}?limit=${limit}&offset=${offset}`,
  )
  if (!res.ok) throw new Error(`GET rows ${res.status}`)
  return (await res.json()) as PagedQueryResult
}

async function installTemplate(teamId: string, template: string): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/templates/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`install failed (${res.status}): ${t}`)
  }
}

async function runExec(teamId: string, sql: string): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`exec failed (${res.status}): ${t}`)
  }
}
