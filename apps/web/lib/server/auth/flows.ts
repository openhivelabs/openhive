/**
 * In-memory OAuth flow registry. Ports apps/server/openhive/auth/flows.py.
 *
 * Each pending connection gets a short-lived FlowState keyed by a random
 * flow_id returned to the client. State expires 5 minutes after creation.
 *
 * Cached on globalThis so Next.js HMR doesn't lose in-flight flows.
 */

import crypto from 'node:crypto'

type FlowKind = 'auth_code' | 'device_code'
type FlowStatus = 'pending' | 'connected' | 'error' | 'expired'

export interface FlowState {
  flow_id: string
  provider_id: string
  kind: FlowKind
  status: FlowStatus
  error: string | null
  created_at: number
  // auth_code
  code_verifier?: string | null
  expected_state?: string | null
  redirect_uri?: string | null
  // device_code
  device_code?: string | null
  user_code?: string | null
  verification_uri?: string | null
  verification_uri_complete?: string | null
  device_interval?: number | null
  device_expires_at?: number | null
  // result
  account_label?: string | null
}

interface FlowsCache {
  map: Map<string, FlowState>
}

const globalForFlows = globalThis as unknown as {
  __openhive_flows?: FlowsCache
}

function store(): Map<string, FlowState> {
  if (!globalForFlows.__openhive_flows) {
    globalForFlows.__openhive_flows = { map: new Map() }
  }
  return globalForFlows.__openhive_flows.map
}

const TTL_MS = 300_000

function gc(): void {
  const now = Date.now()
  const s = store()
  for (const [id, state] of s) {
    if (now - state.created_at > TTL_MS) s.delete(id)
  }
}

function newFlowId(): string {
  return crypto.randomBytes(16).toString('base64url')
}

export function createFlow(
  providerId: string,
  kind: FlowKind,
  fields: Partial<FlowState> = {},
): FlowState {
  gc()
  const state: FlowState = {
    flow_id: newFlowId(),
    provider_id: providerId,
    kind,
    status: 'pending',
    error: null,
    created_at: Date.now(),
    ...fields,
  }
  store().set(state.flow_id, state)
  return state
}

export function getFlow(flowId: string): FlowState | null {
  gc()
  return store().get(flowId) ?? null
}

export function updateFlow(
  flowId: string,
  fields: Partial<FlowState>,
): FlowState | null {
  const state = store().get(flowId)
  if (!state) return null
  Object.assign(state, fields)
  return state
}

function removeFlow(flowId: string): void {
  store().delete(flowId)
}
