import type { ReactNode } from 'react'

/**
 * A declarative primitive spec — the unit of dashboard composition.
 * AI emits these; runtime renders them. No arbitrary code.
 */
export interface PrimitiveSpec {
  /** Registry key, e.g. 'kpi', 'table', 'rows'. */
  primitive: string
  /** Optional id for cross-primitive refs ($ref bindings). */
  id?: string
  /** Primitive-specific config. Shape depends on primitive.name. */
  config?: Record<string, unknown>
  /** Child primitives for container kinds. */
  children?: PrimitiveSpec[]
  /** Event → action map (wired by the renderer). */
  on?: Record<string, ActionSpec>
}

interface ActionSpec {
  /** Action name, e.g. 'delegate_to', 'sql_exec', 'open_block'. */
  action: string
  /** Action parameters (resolved at invocation). */
  params?: Record<string, unknown>
}

/** Catalog entry — what the AI reads to decide how to compose. */
export interface PrimitiveCatalogEntry {
  name: string
  /** One-line summary — shown in primitive lists. */
  summary: string
  /** Multi-line description — when / why to use, not-to-use cases. */
  description: string
  /** Accepted keys in `config`, short schema. */
  configSchema: Record<string, string>
  /** Does this primitive accept children? */
  accepts_children: boolean
  /** Events this primitive emits (bindable via `$ref`). */
  emits?: string[]
  /** Events the renderer wires via `on`. */
  handlers?: string[]
  /** 1–3 canonical spec examples. */
  examples: PrimitiveSpec[]
}

/** Runtime renderable — the React component paired with its catalog. */
export interface PrimitiveDef {
  name: string
  catalog: PrimitiveCatalogEntry
  // biome-ignore lint/suspicious/noExplicitAny: generic primitive renderer
  Component: (props: { spec: PrimitiveSpec; children?: ReactNode }) => ReactNode
}
