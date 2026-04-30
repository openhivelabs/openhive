/**
 * S1 — Subagent result cap + summarise.
 *
 * When a sub-agent returns a very large output (raw HTML dump, 50-page
 * report body, huge JSON paste), injecting it verbatim into the parent's
 * history as a tool_result kills the parent's context window and burns
 * provider quota. Claude Code caps child agent output at 100,000 chars
 * and summarises overflow; this module ports that behaviour.
 *
 * Single hook site: runDelegation happy-path in session.ts (line 1112).
 * Error branch and parallel delegation are out of scope here.
 *
 * See dev/active/runtime-claude-patterns/s1-result-cap.md for the full spec.
 */

import { pickCheapModel } from '../providers/cheap-model'
import { listConnected } from '../tokens'
import { buildMessages, stream as providerStream } from './providers'
import type { AgentSpec } from './team'

// -------- constants --------

export const MAX_CHILD_RESULT_CHARS = 100_000
export const SUMMARY_MAX_CHARS = 4_000
const HEAD_KEEP_CHARS = 500
const TAIL_KEEP_CHARS = 200
const ARTIFACT_PATH_LIMIT = 32

/** LLM summariser hard wall in ms. Exposed so tests can override. */
const LLM_SUMMARY_DEADLINE_MS = 30_000

// -------- types --------

export type SummaryStrategy = 'heuristic' | 'llm' | 'off'

interface CapInput {
  raw: string
  node: AgentSpec
  sessionId: string
  toolCallId: string
  strategy: SummaryStrategy
  maxChars: number
  /** Override for the 30s LLM deadline (tests only). */
  deadlineMs?: number
}

type AppliedStrategy = SummaryStrategy | 'passthrough' | 'envelope'

interface CapResult {
  result: string
  truncated: boolean
  originalChars: number
  summaryStrategy: AppliedStrategy
  artifactPaths: string[]
}

interface StructuredEnvelope {
  ok?: boolean
  files?: unknown[]
  warnings?: unknown[]
  error?: unknown
  [key: string]: unknown
}

// -------- artifact path extraction --------

// All three regexes bound their unbounded runs with {1,512} so a huge
// run of non-whitespace characters (e.g. 100KB of `x`) can't trigger
// super-linear backtracking when the suffix (`.ext`, `/artifacts/`)
// fails to match.
const PATH_REGEXES: RegExp[] = [
  // ~/.openhive/sessions/... up to whitespace or quote
  /~\/\.openhive\/sessions\/[^\s"'`<>]{1,512}/g,
  // absolute paths containing /artifacts/
  /\/[^\s"'`<>/]{0,128}(?:\/[^\s"'`<>/]{0,128}){0,16}\/artifacts\/[^\s"'`<>]{1,256}/g,
  // bare path tokens ending in a known artifact extension
  /[^\s"'`<>]{1,256}\.(?:md|pdf|csv|json|html|txt|xlsx|docx)\b/gi,
]

/**
 * Extract artifact path references from a raw blob. Uses both regex
 * scanning and, if the raw parses as JSON with a `files[*].path` shape,
 * lifts those out too. De-duplicates and caps at ARTIFACT_PATH_LIMIT.
 */
export function extractArtifactPaths(raw: string): string[] {
  const found = new Set<string>()

  const take = (s: string) => {
    if (!s) return
    // strip trailing punctuation that commonly glues onto sentences
    const cleaned = s.replace(/[),.;:]+$/, '')
    if (cleaned) found.add(cleaned)
  }

  for (const rx of PATH_REGEXES) {
    for (const m of raw.matchAll(rx)) {
      take(m[0])
      if (found.size >= ARTIFACT_PATH_LIMIT * 4) break
    }
  }

  // Try JSON envelope — pull path/name from files[] specifically.
  const envelope = detectStructuredEnvelope(raw)
  if (envelope && Array.isArray(envelope.files)) {
    for (const f of envelope.files) {
      if (f && typeof f === 'object') {
        const rec = f as Record<string, unknown>
        if (typeof rec.path === 'string') take(rec.path)
        else if (typeof rec.name === 'string') take(rec.name)
      } else if (typeof f === 'string') {
        take(f)
      }
    }
  }

  // JSON parse may have failed on a giant raw — regex fallback for
  // "path":"..." and "name":"..." so we still catch envelope refs.
  if (!envelope) {
    const fallback = /"(?:path|name)"\s*:\s*"([^"\\]+)"/g
    for (const m of raw.matchAll(fallback)) {
      take(m[1] ?? '')
      if (found.size >= ARTIFACT_PATH_LIMIT * 4) break
    }
  }

  return Array.from(found).slice(0, ARTIFACT_PATH_LIMIT)
}

// -------- structured envelope --------

/**
 * If the raw starts with `{` and parses as JSON with at least one of the
 * known envelope keys (ok/files/warnings/error), return the parsed object.
 * Otherwise null. Truncated JSON throws inside JSON.parse → returns null.
 */
export function detectStructuredEnvelope(raw: string): StructuredEnvelope | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const hasKey =
    Object.hasOwn(obj, 'ok') ||
    Object.hasOwn(obj, 'files') ||
    Object.hasOwn(obj, 'warnings') ||
    Object.hasOwn(obj, 'error')
  if (!hasKey) return null
  return obj as StructuredEnvelope
}

// -------- heuristic summary --------

export function heuristicSummary(
  raw: string,
  paths: string[],
  envelope: StructuredEnvelope | null,
): string {
  const head = raw.slice(0, HEAD_KEEP_CHARS)
  const tail = raw.slice(-TAIL_KEEP_CHARS)
  const parts: string[] = [
    `[truncated subagent output: original ${raw.length.toLocaleString()} chars, kept head/tail + artifact refs]`,
    '',
    '--- head ---',
    head,
    '',
    '--- tail ---',
    tail,
  ]
  if (paths.length > 0) {
    parts.push('', `--- artifacts (${paths.length}) ---`, paths.join('\n'))
  }
  if (envelope) {
    parts.push('', '--- envelope keys ---', Object.keys(envelope).join(', '))
  }
  return parts.join('\n')
}

// -------- LLM summary --------

const SUMMARY_SYSTEM = `You compress a sub-agent's verbose output for its parent agent.
The parent will read your summary as the sub-agent's reply, so write in third person ("the sub-agent ...").

HARD RULES:
- Output strictly under ${SUMMARY_MAX_CHARS} characters.
- Preserve every file path, URL, identifier, and numeric figure verbatim.
- Preserve any error messages verbatim.
- If a structured result envelope (JSON with keys like ok/files/warnings) appears, restate its key fields.
- Lead with a 1-sentence verdict: did the sub-agent succeed, partially succeed, or fail?
- Then bullet the concrete deliverables (artifacts, decisions, numbers).
- Then list any unresolved issues / follow-ups.
- Do NOT invent information not present in the input.`

const summaryUserPrompt = (raw: string, paths: string[]) => {
  const pathsBlock =
    paths.length > 0
      ? `Detected artifact references (preserve these in your summary):\n${paths.join('\n')}\n`
      : ''
  return (
    `Sub-agent raw output (${raw.length.toLocaleString()} chars):\n` +
    `--- BEGIN OUTPUT ---\n${raw}\n--- END OUTPUT ---\n\n${pathsBlock}`
  )
}

/**
 * Pick the model to use for summarisation. Resolution order:
 *   1. Explicit env override (`OPENHIVE_RESULT_SUMMARY_MODEL=provider:model`)
 *   2. Child's own provider+model **if connected**
 *   3. Cheap-model fallback (`pickCheapModel()` walks connected providers)
 *
 * Step 3 covers the case where a user has only connected (say) Anthropic
 * api_key and the child node's provider is `codex` — without the fallback,
 * `providerStream` would throw and we'd lose the summary path.
 */
export function pickSummaryModel(node: AgentSpec): {
  providerId: string
  model: string
} {
  const override = process.env.OPENHIVE_RESULT_SUMMARY_MODEL
  if (override?.includes(':')) {
    const [providerId, ...rest] = override.split(':')
    if (providerId && rest.length > 0) {
      return { providerId, model: rest.join(':') }
    }
  }
  const connected = listConnected()
  if (connected.includes(node.provider_id)) {
    return { providerId: node.provider_id, model: node.model }
  }
  const cheap = pickCheapModel(connected)
  if (cheap) return cheap
  // Last-resort: return the node's own (will likely throw downstream, but
  // matches old behaviour and lets the caller handle it).
  return { providerId: node.provider_id, model: node.model }
}

async function llmSummary(
  input: CapInput,
  paths: string[],
  _envelope: StructuredEnvelope | null,
): Promise<string> {
  const { providerId, model } = pickSummaryModel(input.node)
  const messages = buildMessages(SUMMARY_SYSTEM, [
    { role: 'user', content: summaryUserPrompt(input.raw, paths) },
  ])
  const deadline = Date.now() + (input.deadlineMs ?? LLM_SUMMARY_DEADLINE_MS)
  let collected = ''
  for await (const delta of providerStream(providerId, model, messages, undefined)) {
    if (Date.now() > deadline) break
    if (delta.kind === 'text' && typeof delta.text === 'string') {
      collected += delta.text
      if (collected.length > SUMMARY_MAX_CHARS * 1.5) break
    }
    if (delta.kind === 'stop') break
  }
  const trimmed = collected.trim()
  if (!trimmed) throw new Error('llmSummary returned empty')
  if (trimmed.length > SUMMARY_MAX_CHARS) {
    return `${trimmed.slice(0, SUMMARY_MAX_CHARS)}\n[summary truncated to char limit]`
  }
  return trimmed
}

// -------- main entry --------

export async function capAndSummarise(input: CapInput): Promise<CapResult> {
  const originalChars = input.raw.length
  const paths = extractArtifactPaths(input.raw)
  const envelope = detectStructuredEnvelope(input.raw)

  // Passthrough — well under the cap.
  if (originalChars <= input.maxChars) {
    debugLog(input, 'passthrough', originalChars, originalChars, paths.length)
    return {
      result: input.raw,
      truncated: false,
      originalChars,
      summaryStrategy: 'passthrough',
      artifactPaths: paths,
    }
  }

  // Envelope preservation — if the parsed envelope serialises to within
  // the cap it's more useful to the parent LLM than head/tail slicing.
  if (envelope) {
    try {
      const serialised = JSON.stringify(envelope, null, 2)
      if (serialised.length <= input.maxChars) {
        debugLog(input, 'envelope', originalChars, serialised.length, paths.length)
        return {
          result: serialised,
          truncated: true,
          originalChars,
          summaryStrategy: 'passthrough',
          artifactPaths: paths,
        }
      }
    } catch {
      // Fall through to strategy branch.
    }
  }

  // Strategy branch.
  let result: string
  let applied: AppliedStrategy
  if (input.strategy === 'off') {
    result = `${input.raw.slice(0, input.maxChars)}\n[truncated — summarisation off]`
    applied = 'off'
  } else if (input.strategy === 'llm') {
    try {
      result = await llmSummary(input, paths, envelope)
      applied = 'llm'
    } catch (err) {
      console.warn(
        '[result-cap] llm summary failed, fell back to heuristic:',
        err instanceof Error ? err.message : err,
      )
      result = heuristicSummary(input.raw, paths, envelope)
      applied = 'heuristic'
    }
  } else {
    result = heuristicSummary(input.raw, paths, envelope)
    applied = 'heuristic'
  }

  debugLog(input, applied, originalChars, result.length, paths.length)
  return {
    result,
    truncated: true,
    originalChars,
    summaryStrategy: applied,
    artifactPaths: paths,
  }
}

function debugLog(
  input: CapInput,
  strategy: AppliedStrategy,
  original: number,
  finalLen: number,
  pathCount: number,
): void {
  if (process.env.OPENHIVE_DEBUG_RESULT_CAP !== '1') return
  const tag = `${input.node.role}#${input.node.id}`
  console.log(
    `[result-cap] node=${tag} strategy=${strategy} original=${original} → ${finalLen} chars, paths=${pathCount}`,
  )
}
