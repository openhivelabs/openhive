/**
 * Next.js instrumentation hook. Runs once per server process start (dev
 * reload + prod boot).
 *
 * Node-only work (scheduler, FS migrations, signal handlers) lives in
 * `instrumentation-node.ts` and is dynamic-imported under a NEXT_RUNTIME
 * gate so the Edge bundle never sees `process.once` etc.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { registerNode } = await import('./instrumentation-node')
  await registerNode()
}
