'use client'

import { REGISTRY } from '@/lib/primitives/registry'
import type { PrimitiveSpec } from '@/lib/primitives/types'

interface Props {
  spec: PrimitiveSpec
}

/**
 * Renders a primitive tree. Walks the spec, looks up the component in the
 * registry, recursively renders children. Unknown primitives render a fallback
 * so the whole tree doesn't crash on a typo.
 */
export function PrimitiveRenderer({ spec }: Props) {
  const def = REGISTRY[spec.primitive]
  if (!def) {
    return (
      <div className="rounded-sm border border-dashed border-red-300 bg-red-50 text-red-700 text-[12px] px-2.5 py-1.5 font-mono">
        unknown primitive: <b>{spec.primitive}</b>
      </div>
    )
  }
  const children = (spec.children ?? []).map((child, i) => (
    <PrimitiveRenderer key={child.id ?? `${child.primitive}-${i}`} spec={child} />
  ))
  const Component = def.Component
  return <Component spec={spec}>{children.length > 0 ? children : null}</Component>
}
