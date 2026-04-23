/**
 * Streaming post-processor that strips meta-label blocks from assistant text
 * before it reaches the UI.
 *
 * Rationale: small models (gpt-5-mini) ignore negative prompt instructions
 * like "do not emit section headers". When they leak labels like "요약:",
 * "가정:", "artifacts:" or "다음 단계", we strip them server-side as a
 * safety net so the user never sees internal bookkeeping.
 *
 * Keep the pattern list CONSERVATIVE — we only strip labels that appear
 * at the start of a line AND are followed by a newline or only colon-
 * formatted content on the same line. Substantive prose that happens to
 * start with "Summary:" mid-paragraph is NOT matched.
 *
 * Streaming-safe: we buffer up to the next blank line (double newline)
 * before deciding whether to emit. A small trailing buffer (up to ~400
 * chars) is flushed on stream end.
 */

/**
 * Two-tier label detection.
 *
 * Tier A: phrases that are unambiguously menu / section intros — never a
 * natural sentence opener. Strip the paragraph regardless of what follows
 * (parentheses, list items, etc).
 *
 * Tier B: words that COULD be natural-sentence openers ("Summary of Q3
 * sales...") but are meta-labels when followed by a colon or newline.
 */
const META_LABEL_INTRO_RE =
  /^(?:다음 행동|다음 단계|next steps?|next actions?|次のステップ|산출물|생성된 파일|첨부|첨부\s*파일|첨부파일|다운로드|보조\s*자료|참고\s*자료|attachments?|downloads?|attached\s*files?|generated\s*files?|deliverables?)(?:\s|[:：(（]|$)/i

const META_LABEL_COLON_RE =
  /^(?:artifacts?|파일|가정|assumption|assumptions|summary|요약|제안\s*사항|제안|참고|note|notes)\s*[:：]/i

const META_LABEL_BARE_LINE_RE =
  /^(?:artifacts?|가정|assumption|summary|요약|산출물)\s*$/i

/**
 * Paren-headed meta labels like "참고(보조 자료)" or "첨부(다운로드)" —
 * gpt-5-mini habit in Korean output for enumerating attachments. Bare
 * `참고` or `첨부` is too generic to strip unconditionally ("참고 바랍니다"
 * is legitimate prose), so we require the open-paren boundary.
 */
const META_LABEL_PAREN_INTRO_RE =
  /^(?:참고|첨부|다운로드|보조|downloads?|attachments?)\s*[(（]/i

/** Cheap paragraph-boundary split. A paragraph ends at a blank line (\n\n). */
const PARAGRAPH_SPLIT = /\n\s*\n/

/**
 * Strip meta-label paragraphs from a complete text blob (non-streaming).
 * Used for unit tests and as the core of the streaming version.
 */
function isMetaLabelParagraph(firstLine: string): boolean {
  return (
    META_LABEL_INTRO_RE.test(firstLine) ||
    META_LABEL_COLON_RE.test(firstLine) ||
    META_LABEL_BARE_LINE_RE.test(firstLine) ||
    META_LABEL_PAREN_INTRO_RE.test(firstLine)
  )
}

export function stripMetaLabels(text: string): string {
  if (!text) return text
  // Split into paragraphs; drop any whose first non-whitespace line starts
  // with a meta label. Preserve the paragraph separators of surviving ones.
  const parts = text.split(PARAGRAPH_SPLIT)
  const kept: string[] = []
  for (const p of parts) {
    const firstLine = p.replace(/^\s+/, '').split('\n', 1)[0] ?? ''
    if (isMetaLabelParagraph(firstLine)) continue
    kept.push(p)
  }
  // Trim trailing whitespace — often a blank line remains when we dropped a
  // final paragraph.
  return kept.join('\n\n').replace(/\s+$/, '')
}

/**
 * Streaming variant: wraps an async iterable of text chunks. Buffers up to
 * the next paragraph break before emitting, so a label at the START of a
 * paragraph can be recognised even if it streams in piece-meal. On stream
 * end, flushes whatever remains after one final strip pass.
 *
 * The buffer is bounded: if a paragraph grows past MAX_BUFFER chars without
 * a blank line, we flush it (substantive content — not a label block).
 */
const MAX_BUFFER = 2000

/**
 * Strip `artifact://` markdown links whose URIs don't resolve to a real
 * session artifact. The sub-agent has `<delegation-artifacts>` injection
 * + the Lead has a `<session-artifacts>` manifest, so any artifact:// URI
 * in the Lead's final text that's NOT in the real list is a hallucination
 * — probably repeated from a fabricated sub-agent response.
 *
 * Strategy:
 * - For each `[label](artifact://...)` markdown link, check the URI against
 *   the provided whitelist. Unknown → replace the whole link with just
 *   "[label]" (keep the display text so sentence structure survives).
 * - For bare `artifact://` URIs (no link wrapper), same check; unknown →
 *   remove the URI.
 */
const MD_ARTIFACT_LINK_RE = /\[([^\]]+)\]\((artifact:\/\/[^)\s]+)\)/g
const BARE_ARTIFACT_URI_RE = /(?<![\]()])artifact:\/\/[^\s)]+/g

/**
 * Normalise an artifact URI for equality comparison. LLMs (especially
 * gpt-5-mini) auto percent-encode non-ASCII path segments when emitting
 * markdown links — "꼬북칩.pdf" → "%EA%BC%AC%EB%B6%81%EC%B9%A9.pdf".
 * The real-URI set stores raw UTF-8 paths (what's on disk), so a
 * byte-literal `Set.has()` falsely marks the link as hallucinated and
 * strips the URI, leaving a dangling `[label]` in the user-facing text.
 *
 * Fix: compare decode-once. `%20` / `%EA...` and the raw byte both
 * collapse to the same canonical form. `decodeURIComponent` can throw on
 * malformed escapes — in that case fall back to the original string so a
 * garbage URI is treated as non-matching rather than crashing the strip.
 */
function canonicalizeArtifactUri(uri: string): string {
  try {
    return decodeURIComponent(uri)
  } catch {
    return uri
  }
}

export function stripFakeArtifactLinks(text: string, realUris: Set<string>): string {
  if (!text) return text
  // Build a canonical-form set once per call so the hot-path inside
  // `.replace` is a straight `has()` lookup.
  const canonicalReal = new Set<string>()
  for (const u of realUris) canonicalReal.add(canonicalizeArtifactUri(u))
  let out = text.replace(MD_ARTIFACT_LINK_RE, (full, label, uri) => {
    if (canonicalReal.has(canonicalizeArtifactUri(uri))) return full
    return `[${label}]`
  })
  out = out.replace(BARE_ARTIFACT_URI_RE, (uri) => {
    if (canonicalReal.has(canonicalizeArtifactUri(uri))) return uri
    return ''
  })
  return out
}

export async function* stripMetaLabelsStreaming(
  src: AsyncIterable<string>,
): AsyncIterable<string> {
  let buf = ''
  for await (const chunk of src) {
    buf += chunk
    // Emit everything up to the last blank line — that part is a stable
    // sequence of complete paragraphs we can strip now.
    const lastBreak = buf.lastIndexOf('\n\n')
    if (lastBreak >= 0) {
      const stable = buf.slice(0, lastBreak + 2)
      const tail = buf.slice(lastBreak + 2)
      const cleaned = stripMetaLabels(stable)
      if (cleaned) yield `${cleaned}\n\n`
      buf = tail
    } else if (buf.length > MAX_BUFFER) {
      // Safety: unbounded single paragraph — flush without stripping.
      yield buf
      buf = ''
    }
  }
  if (buf.length > 0) {
    const cleaned = stripMetaLabels(buf)
    if (cleaned) yield cleaned
  }
}
