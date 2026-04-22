/**
 * Team snapshot the engine runs against.
 * Ports apps/server/openhive/engine/team.py.
 *
 * This is the wire-format the frontend sends when starting a run. The engine
 * doesn't own YAML loading — callers hand it a self-contained TeamSpec.
 */

/** Hard ceiling on per-agent parallel instances. User-set value is clamped. */
export const HARD_MAX_PARALLEL = 100

export interface AgentSpec {
  id: string
  role: string
  label: string
  provider_id: string
  model: string
  system_prompt: string
  skills: string[]
  /**
   * Ceiling on parallel invocations of THIS agent via delegate_parallel.
   * 1 = serial only. The Lead of a team is forced to 1 regardless.
   */
  max_parallel: number
  /** Path to a persona file (.md) or directory (AGENT.md inside). */
  persona_path: string | null
  /** Named persona, resolved via the agent loader's lookup roots. */
  persona_name: string | null
  /**
   * Optional cap on how much of this agent's output is injected back into
   * the parent's history when it is delegated to. `strategy: 'off'` still
   * truncates at `max_chars` but skips summarisation. See
   * lib/server/engine/result-cap.ts (S1).
   */
  result_cap?: {
    strategy?: 'heuristic' | 'llm' | 'off'
    max_chars?: number
  }
}

export interface EdgeSpec {
  source: string
  target: string
}

export interface RunLimits {
  max_tool_rounds_per_turn: number
  max_delegation_depth: number
}

export interface TeamSpec {
  id: string
  name: string
  agents: AgentSpec[]
  edges: EdgeSpec[]
  /** Entry agent ID; defaults to Lead (no incoming edges). */
  entry_agent_id: string | null
  /** Skill IDs every agent in this team may use. */
  allowed_skills: string[]
  /**
   * Names of MCP servers whose tools every agent may invoke. Each server's
   * tools are injected as `<server>__<tool>` so a team can enable multiple
   * servers without name collisions.
   */
  allowed_mcp_servers: string[]
  limits: RunLimits
  /**
   * Optional domain tag (e.g. "research", "sales"). Used by the work ledger
   * (S4) to group cross-team history under a user-meaningful category.
   * Falls back to `id` when unset.
   */
  domain?: string
}

function clampParallel(v: number): number {
  if (!Number.isFinite(v)) return 1
  if (v < 1) return 1
  if (v > HARD_MAX_PARALLEL) return HARD_MAX_PARALLEL
  return Math.trunc(v)
}

/** Normalise a raw agent dict (wire shape) into an AgentSpec with defaults. */
export function toAgentSpec(raw: Record<string, unknown>): AgentSpec {
  return {
    id: String(raw.id ?? ''),
    role: String(raw.role ?? ''),
    label: String(raw.label ?? ''),
    provider_id: String(raw.provider_id ?? ''),
    model: String(raw.model ?? ''),
    system_prompt: String(raw.system_prompt ?? ''),
    skills: Array.isArray(raw.skills)
      ? (raw.skills as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    max_parallel: clampParallel(Number(raw.max_parallel ?? 1)),
    persona_path:
      typeof raw.persona_path === 'string' && raw.persona_path
        ? raw.persona_path
        : null,
    persona_name:
      typeof raw.persona_name === 'string' && raw.persona_name
        ? raw.persona_name
        : null,
    result_cap:
      raw.result_cap && typeof raw.result_cap === 'object' && !Array.isArray(raw.result_cap)
        ? (raw.result_cap as AgentSpec['result_cap'])
        : undefined,
  }
}

export function toTeamSpec(raw: Record<string, unknown>): TeamSpec {
  const agents = Array.isArray(raw.agents)
    ? (raw.agents as unknown[])
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a))
        .map(toAgentSpec)
    : []
  const edges = Array.isArray(raw.edges)
    ? (raw.edges as unknown[])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
        .map((e) => ({ source: String(e.source ?? ''), target: String(e.target ?? '') }))
    : []
  const limitsRaw =
    raw.limits && typeof raw.limits === 'object' && !Array.isArray(raw.limits)
      ? (raw.limits as Record<string, unknown>)
      : {}
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    agents,
    edges,
    entry_agent_id:
      typeof raw.entry_agent_id === 'string' && raw.entry_agent_id
        ? raw.entry_agent_id
        : null,
    allowed_skills: Array.isArray(raw.allowed_skills)
      ? (raw.allowed_skills as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    allowed_mcp_servers: Array.isArray(raw.allowed_mcp_servers)
      ? (raw.allowed_mcp_servers as unknown[]).filter(
          (s): s is string => typeof s === 'string',
        )
      : [],
    limits: {
      max_tool_rounds_per_turn: Number(limitsRaw.max_tool_rounds_per_turn ?? 8),
      max_delegation_depth: Number(limitsRaw.max_delegation_depth ?? 4),
    },
    domain: typeof raw.domain === 'string' ? raw.domain : undefined,
  }
}

// -------- graph helpers --------

export function findAgent(team: TeamSpec, agentId: string): AgentSpec | null {
  return team.agents.find((a) => a.id === agentId) ?? null
}

export function subordinates(team: TeamSpec, agentId: string): AgentSpec[] {
  const targets = new Set(
    team.edges.filter((e) => e.source === agentId).map((e) => e.target),
  )
  return team.agents.filter((a) => targets.has(a.id))
}

/** Lead = root (no incoming edge). Prefer one that has subordinates. */
export function leadAgent(team: TeamSpec): AgentSpec {
  const incoming = new Set(team.edges.map((e) => e.target))
  const roots = team.agents.filter((a) => !incoming.has(a.id))
  if (roots.length === 0) {
    if (team.agents.length === 0) {
      throw new Error('team has no agents')
    }
    return team.agents[0]!
  }
  const withReports = roots.filter((a) => subordinates(team, a.id).length > 0)
  return withReports[0] ?? roots[0]!
}

export function entryAgent(team: TeamSpec): AgentSpec {
  if (team.entry_agent_id) {
    const found = findAgent(team, team.entry_agent_id)
    if (found) return found
  }
  return leadAgent(team)
}
