'use client'

import Link from 'next/link'
import { PrimitiveRenderer } from '@/components/primitives/Renderer'
import { REGISTRY } from '@/lib/primitives/registry'
import type { PrimitiveSpec } from '@/lib/primitives/types'

/**
 * Dev gallery — renders the first example of every primitive so the AI's
 * catalog matches what humans see. Route: /primitives
 */
export default function PrimitivesGalleryPage() {
  const entries = Object.values(REGISTRY)
  return (
    <div className="min-h-screen bg-neutral-100 dark:bg-neutral-950">
      <header className="sticky top-0 bg-white dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 z-10">
        <div className="max-w-[1100px] mx-auto px-6 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-semibold">Primitive gallery</h1>
            <p className="text-[12px] text-neutral-500 mt-0.5">{entries.length} primitives</p>
          </div>
          <Link
            href="/"
            className="text-[12px] text-neutral-600 hover:text-neutral-900 font-mono"
          >
            ← back
          </Link>
        </div>
      </header>

      <main className="max-w-[1100px] mx-auto px-6 py-6 space-y-5">
        {entries.map(({ name, catalog }) => (
          <section
            key={name}
            className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden"
          >
            <header className="px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-3">
              <code className="text-[13px] font-mono font-semibold text-neutral-900 dark:text-neutral-100">
                {name}
              </code>
              <span className="text-[12px] text-neutral-500">{catalog.summary}</span>
            </header>

            <div className="px-4 py-3 bg-neutral-50/60 dark:bg-neutral-900/40 border-b border-neutral-200 dark:border-neutral-800">
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 font-medium mb-1.5">
                Preview
              </div>
              {renderExample(catalog.examples[0]) ?? (
                <div className="text-[12px] text-neutral-400 font-mono">no example</div>
              )}
            </div>

            <details className="text-[12px]">
              <summary className="px-4 py-2 cursor-pointer text-neutral-500 hover:text-neutral-800">
                Spec &amp; schema
              </summary>
              <div className="px-4 pb-3 space-y-2">
                <p className="text-[12px] text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  {catalog.description}
                </p>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium mb-1">
                    config
                  </div>
                  <pre className="text-[11px] bg-neutral-950 text-neutral-100 px-3 py-2 rounded-sm overflow-x-auto">
                    {JSON.stringify(catalog.configSchema, null, 2)}
                  </pre>
                </div>
                {catalog.emits && (
                  <div className="text-[11px] text-neutral-500">
                    <span className="font-medium">emits:</span> {catalog.emits.join(', ')}
                  </div>
                )}
                {catalog.handlers && (
                  <div className="text-[11px] text-neutral-500">
                    <span className="font-medium">handlers:</span> {catalog.handlers.join(', ')}
                  </div>
                )}
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium mb-1">
                    example spec
                  </div>
                  <pre className="text-[11px] bg-neutral-950 text-neutral-100 px-3 py-2 rounded-sm overflow-x-auto">
                    {JSON.stringify(catalog.examples[0], null, 2)}
                  </pre>
                </div>
              </div>
            </details>
          </section>
        ))}
      </main>
    </div>
  )
}

function renderExample(spec: PrimitiveSpec | undefined) {
  if (!spec) return null
  try {
    return <PrimitiveRenderer spec={spec} />
  } catch (e) {
    return (
      <div className="text-[12px] text-red-600 font-mono">
        error: {e instanceof Error ? e.message : String(e)}
      </div>
    )
  }
}
