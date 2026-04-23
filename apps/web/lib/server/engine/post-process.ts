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
  /^(?:다음 행동|다음 단계|next steps?|next actions?|次のステップ|산출물|생성된 파일)(?:\s|[:：(（]|$)/i

const META_LABEL_COLON_RE =
  /^(?:artifacts?|파일|가정|assumption|assumptions|summary|요약|제안\s*사항|제안|참고|note|notes)\s*[:：]/i

const META_LABEL_BARE_LINE_RE =
  /^(?:artifacts?|가정|assumption|summary|요약|산출물)\s*$/i

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
    META_LABEL_BARE_LINE_RE.test(firstLine)
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
