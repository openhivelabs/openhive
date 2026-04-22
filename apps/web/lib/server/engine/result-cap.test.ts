/**
 * S1 unit tests — result-cap.ts.
 *
 * Cases A–H mirror dev/active/runtime-claude-patterns/s1-result-cap.md
 * §Test Plan. providers.stream is mocked for the llm-strategy cases so
 * we never hit the wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock providers.stream before importing the unit under test. We
// replace the whole module so there is no chance real provider code
// runs during these tests.
vi.mock('./providers', () => ({
  stream: vi.fn(),
  buildMessages: (system: string, history: unknown[]) => {
    const out: unknown[] = []
    if (system) out.push({ role: 'system', content: system })
    out.push(...history)
    return out
  },
}))

import * as providers from './providers'
import {
  MAX_CHILD_RESULT_CHARS,
  SUMMARY_MAX_CHARS,
  capAndSummarise,
  detectStructuredEnvelope,
  extractArtifactPaths,
  heuristicSummary,
  pickSummaryModel,
} from './result-cap'
import type { AgentSpec } from './team'

const makeNode = (overrides: Partial<AgentSpec> = {}): AgentSpec => ({
  id: 'agent-1',
  role: 'researcher',
  label: 'Researcher',
  provider_id: 'copilot',
  model: 'gpt-4o-mini',
  system_prompt: '',
  skills: [],
  max_parallel: 1,
  persona_path: null,
  persona_name: null,
  ...overrides,
})

const baseInput = (
  raw: string,
  overrides: Partial<Parameters<typeof capAndSummarise>[0]> = {},
) => ({
  raw,
  node: makeNode(),
  sessionId: 'sess-1',
  toolCallId: 'tool-1',
  strategy: 'heuristic' as const,
  maxChars: MAX_CHILD_RESULT_CHARS,
  ...overrides,
})

const streamSpy = providers.stream as unknown as ReturnType<typeof vi.fn>

/** Helper: async generator that yields the given deltas in order. */
function* syncGen<T>(items: T[]): Generator<T> {
  for (const i of items) yield i
}
async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i
}

const CLEARED_ENV_KEYS = [
  'OPENHIVE_RESULT_MAX_CHARS',
  'OPENHIVE_RESULT_SUMMARY_MODEL',
  'OPENHIVE_DEBUG_RESULT_CAP',
]

function clearEnvKeys(keys: string[]): void {
  for (const k of keys) {
    // Detach the key entirely — plain assignment of `undefined` stores
    // the literal string "undefined" in Node's process.env.
    Reflect.deleteProperty(process.env, k)
  }
}

describe('result-cap', () => {
  beforeEach(() => {
    streamSpy.mockReset()
    clearEnvKeys(CLEARED_ENV_KEYS)
  })
  afterEach(() => {
    streamSpy.mockReset()
  })

  // ---- helpers ----

  it('extractArtifactPaths finds session paths, artifact paths, and extensions', () => {
    const raw = [
      'Saved to ~/.openhive/sessions/sess-abc/artifacts/report.pdf.',
      'Also wrote /tmp/workdir/artifacts/notes.md and see output.csv!',
      'Nothing interesting here.',
    ].join('\n')
    const paths = extractArtifactPaths(raw)
    expect(paths).toEqual(
      expect.arrayContaining([
        '~/.openhive/sessions/sess-abc/artifacts/report.pdf',
        '/tmp/workdir/artifacts/notes.md',
      ]),
    )
    expect(paths.some((p) => p.endsWith('output.csv'))).toBe(true)
  })

  it('detectStructuredEnvelope parses valid envelopes and rejects unrelated JSON', () => {
    expect(detectStructuredEnvelope('{"ok":true,"files":[]}')).toEqual({
      ok: true,
      files: [],
    })
    expect(detectStructuredEnvelope('{"random":1}')).toBeNull()
    expect(detectStructuredEnvelope('not json')).toBeNull()
    expect(detectStructuredEnvelope('{ "ok": true, trunc')).toBeNull()
  })

  it('heuristicSummary includes head, tail, artifact list, and envelope keys', () => {
    const raw = `${'A'.repeat(600)}${'B'.repeat(10_000)}${'Z'.repeat(300)}`
    const out = heuristicSummary(raw, ['x/y/z.md'], { ok: true, files: [] })
    expect(out).toContain('--- head ---')
    expect(out).toContain('--- tail ---')
    expect(out).toContain('x/y/z.md')
    expect(out).toContain('--- envelope keys ---')
    expect(out).toMatch(/truncated subagent output: original [\d,]+ chars/)
  })

  it('pickSummaryModel respects env override with provider:model', () => {
    process.env.OPENHIVE_RESULT_SUMMARY_MODEL = 'copilot:gpt-4o-mini'
    expect(pickSummaryModel(makeNode({ provider_id: 'claude-code', model: 'x' }))).toEqual({
      providerId: 'copilot',
      model: 'gpt-4o-mini',
    })
  })

  it('pickSummaryModel falls back to the child node when no env override', () => {
    expect(pickSummaryModel(makeNode({ provider_id: 'claude-code', model: 'opus' }))).toEqual({
      providerId: 'claude-code',
      model: 'opus',
    })
  })

  // ---- spec Cases A–H ----

  // Case A — passthrough
  it('Case A: passthrough for 50KB plain text', async () => {
    const raw = 'x'.repeat(50_000)
    const res = await capAndSummarise(baseInput(raw))
    expect(res.truncated).toBe(false)
    expect(res.summaryStrategy).toBe('passthrough')
    expect(res.originalChars).toBe(50_000)
    expect(res.result.length).toBe(50_000)
  })

  // Case B — heuristic summary of 200KB
  it('Case B: heuristic summary of 200KB plain text', async () => {
    const head = 'H'.repeat(1000)
    const mid = 'M'.repeat(198_000)
    const tail = 'T'.repeat(1000)
    const raw = head + mid + tail
    expect(raw.length).toBe(200_000)
    const res = await capAndSummarise(baseInput(raw, { strategy: 'heuristic' }))
    expect(res.truncated).toBe(true)
    expect(res.originalChars).toBe(200_000)
    expect(res.summaryStrategy).toBe('heuristic')
    // head (first 500 Hs) and tail (last 200 Ts) must be present
    expect(res.result).toContain('H'.repeat(500))
    expect(res.result).toContain('T'.repeat(200))
    expect(res.result.length).toBeLessThan(6_000)
  })

  // Case C — artifact path survives cap
  it('Case C: artifact path survives cap', async () => {
    const marker = '~/.openhive/sessions/sess-1/artifacts/report.pdf'
    const raw = `${'x'.repeat(100_000)} ${marker} ${'y'.repeat(100_000)}`
    const res = await capAndSummarise(baseInput(raw))
    expect(res.truncated).toBe(true)
    expect(res.artifactPaths).toContain(marker)
  })

  // Case D — envelope preserved
  it('Case D: JSON envelope preserved verbatim (round-trips)', async () => {
    // Small envelope; pad the raw payload so originalChars exceeds
    // maxChars but the pretty-serialised envelope fits.
    const envelope = {
      ok: true,
      files: [{ path: 'a.md' }, { path: 'b.csv' }],
      warnings: [],
    }
    const compact = JSON.stringify(envelope)
    const raw = `${compact}${' '.repeat(5_000)}`
    const res = await capAndSummarise(baseInput(raw, { maxChars: raw.length - 1 }))
    expect(res.truncated).toBe(true)
    expect(res.summaryStrategy).toBe('passthrough')
    const parsed = JSON.parse(res.result) as typeof envelope
    expect(parsed.ok).toBe(true)
    expect(parsed.files).toHaveLength(2)
  })

  // Case F — LLM strategy fallback on provider error
  it('Case F: llm strategy falls back to heuristic on stream throw', async () => {
    streamSpy.mockImplementation(() => {
      throw new Error('provider boom')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = 'x'.repeat(200_000)
    const res = await capAndSummarise(baseInput(raw, { strategy: 'llm' }))
    expect(res.truncated).toBe(true)
    expect(res.summaryStrategy).toBe('heuristic')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // Extra: LLM strategy happy path (exercises the stream mock)
  it('Case F.ok: llm strategy consumes text deltas and marks summary_strategy=llm', async () => {
    streamSpy.mockImplementation(() =>
      asyncGen([
        { kind: 'text', text: 'The sub-agent succeeded. Wrote a.md and b.csv.' },
        { kind: 'stop', reason: 'stop' },
      ]),
    )
    const raw = 'x'.repeat(200_000)
    const res = await capAndSummarise(baseInput(raw, { strategy: 'llm' }))
    expect(res.truncated).toBe(true)
    expect(res.summaryStrategy).toBe('llm')
    expect(res.result).toContain('sub-agent')
    expect(res.result.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS)
  })

  // Case G — strategy 'off'
  it("Case G: 'off' strategy truncates to maxChars without summarisation", async () => {
    streamSpy.mockImplementation(() => {
      throw new Error('must not be called')
    })
    const raw = 'x'.repeat(200_000)
    const res = await capAndSummarise(
      baseInput(raw, {
        strategy: 'off',
        maxChars: MAX_CHILD_RESULT_CHARS,
      }),
    )
    expect(res.truncated).toBe(true)
    expect(res.summaryStrategy).toBe('off')
    expect(res.result).toContain('[truncated — summarisation off]')
    expect(res.result.length).toBeLessThanOrEqual(MAX_CHILD_RESULT_CHARS + 50)
    expect(streamSpy).not.toHaveBeenCalled()
  })

  // Case H — env-style override via maxChars injection (simulating env fallback)
  it('Case H: maxChars override forces truncation below default cap', async () => {
    const raw = 'x'.repeat(11_000)
    const res = await capAndSummarise(baseInput(raw, { maxChars: 10_000 }))
    expect(res.truncated).toBe(true)
    expect(res.originalChars).toBe(11_000)
    expect(res.summaryStrategy).toBe('heuristic')
  })

  // Bonus guard from Case E context: short "error" strings are passthrough.
  // Case E is enforced at the call-site in session.ts (error branch does not
  // invoke capAndSummarise at all). Here we verify the input shape is safe.
  it('Case E-surrogate: short error-like raw passes through unchanged', async () => {
    const raw = 'ERROR: upstream 500 Bad Gateway'
    const res = await capAndSummarise(baseInput(raw))
    expect(res.truncated).toBe(false)
    expect(res.result).toBe(raw)
  })

  // LLM deadline guard — should bail out without hanging.
  it('llm strategy respects deadline override and falls back when no content arrives', async () => {
    streamSpy.mockImplementation(async function* () {
      // Yield one delta then simulate slow stream by awaiting forever… we
      // short-circuit by yielding a single empty text then returning.
      yield { kind: 'text', text: '' }
      yield { kind: 'stop', reason: 'stop' }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = 'x'.repeat(200_000)
    const res = await capAndSummarise(baseInput(raw, { strategy: 'llm', deadlineMs: 10 }))
    // Empty output → llmSummary throws → heuristic fallback
    expect(res.summaryStrategy).toBe('heuristic')
    warnSpy.mockRestore()
  })
})

// Silence unused import warning for the sync helper.
void syncGen
