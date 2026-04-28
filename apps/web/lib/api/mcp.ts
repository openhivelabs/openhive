interface PresetInput {
  key: string
  label: string
  type: 'secret' | 'text' | 'path'
  placeholder: string
  help_text: string
  required: boolean
}

export interface Preset {
  id: string
  name: string
  icon: string
  /** simple-icons brand id (e.g. "notion"). Empty if no brand mark available. */
  brand: string
  /** Optional URL/path to a full-color brand asset (e.g. "/brands/notion.svg"). */
  icon_url: string
  description: string
  /** Stub: card shows in gallery but Connect is disabled. */
  coming_soon: boolean
  inputs: PresetInput[]
}

export interface InstalledServer {
  name: string
  preset_id: string | null
  command: string
  args: string[]
  env_keys: string[]
  running: boolean
  last_error: string | null
  tool_count: number | null
}

export interface DiscoveredTool {
  name: string
  description: string
}

interface TestResult {
  ok: boolean
  error?: string
  tools?: DiscoveredTool[]
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status}: ${body}`)
  }
  return (await res.json()) as T
}

export async function fetchPresets(): Promise<Preset[]> {
  return jsonOrThrow(await fetch('/api/mcp/presets'))
}

export async function fetchServers(): Promise<InstalledServer[]> {
  return jsonOrThrow(await fetch('/api/mcp/servers'))
}

export async function fetchServerTools(name: string): Promise<{ name: string; tools: DiscoveredTool[] }> {
  return jsonOrThrow(await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/tools`))
}

export async function installFromPreset(
  preset_id: string,
  name: string,
  inputs: Record<string, string>,
): Promise<void> {
  await jsonOrThrow(
    await fetch('/api/mcp/servers/from-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset_id, name, inputs }),
    }),
  )
}

export async function deleteServer(name: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  )
}

export async function restartServer(name: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/restart`, { method: 'POST' }),
  )
}

export async function testInstalledServer(name: string): Promise<TestResult> {
  const res = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/test`, {
    method: 'POST',
  })
  return jsonOrThrow(res)
}

export async function testDraft(args: {
  preset_id?: string
  inputs?: Record<string, string>
  server?: { command: string; args: string[]; env: Record<string, string> }
}): Promise<TestResult> {
  const res = await fetch('/api/mcp/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return jsonOrThrow(res)
}

// -------- AI-generated user MCP servers --------

interface UserMcpCredentialSpec {
  ref_id: string
  env_name: string
  purpose: string
}

interface UserMcpToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
  side_effects: 'read' | 'write'
}

interface UserMcpManifest {
  name: string
  description: string
  allowed_hosts: string[]
  required_credentials: UserMcpCredentialSpec[]
  tools: UserMcpToolSpec[]
}

export interface UserMcpSummary {
  name: string
  manifest: UserMcpManifest
  installed_at: number
  approved: boolean
}

export interface UserMcpFullRecord extends UserMcpSummary {
  code: string
  approved_hash: string | null
}

export async function fetchUserServers(): Promise<UserMcpSummary[]> {
  const res = await fetch('/api/mcp/user')
  return jsonOrThrow(res)
}

export async function fetchUserServer(name: string): Promise<UserMcpFullRecord> {
  const res = await fetch(`/api/mcp/user/${encodeURIComponent(name)}`)
  return jsonOrThrow(res)
}

export async function approveUserServer(name: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/mcp/user/${encodeURIComponent(name)}/approve`, { method: 'POST' }),
  )
}

export async function deleteUserServer(name: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/mcp/user/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  )
}

async function generateUserServer(args: {
  manifest: UserMcpManifest
  code: string
}): Promise<{ name: string }> {
  const res = await fetch('/api/mcp/user/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return jsonOrThrow(res)
}
