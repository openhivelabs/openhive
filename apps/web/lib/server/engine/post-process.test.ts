import { describe, it, expect } from 'vitest'
import {
  stripFakeArtifactLinks,
  stripMetaLabels,
  stripMetaLabelsStreaming,
} from './post-process'

describe('stripMetaLabels', () => {
  it('passes clean text through', () => {
    const t = '안녕하세요! 무엇을 도와드릴까요?'
    expect(stripMetaLabels(t)).toBe(t)
  })

  it('strips "artifacts: ..." block at paragraph start', () => {
    const t =
      '안녕하세요! 무엇을 도와드릴까요?\n\nartifacts\n해당 세션에서 생성된 파일/링크: 없음'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/artifacts/)
    expect(out).toMatch(/안녕하세요/)
  })

  it('strips Korean 가정 meta-label block', () => {
    const t = '결과 요약입니다.\n\n가정: 한국어 비공식 톤으로 응답했습니다.'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/가정/)
    expect(out).toMatch(/결과 요약입니다/)
  })

  it('strips English "Summary:" paragraph', () => {
    const t = 'Here is the result.\n\nSummary: short greeting, no ask.'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/Summary/)
    expect(out).toMatch(/Here is the result/)
  })

  it('strips "다음 행동" / "다음 단계" menu block', () => {
    const t =
      '안녕하세요!\n\n다음 행동 (예시 — 편한 항목 골라 말씀해 주세요)\n- 문서 작성\n- 번역'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/다음 행동/)
    expect(out).toMatch(/안녕하세요!/)
  })

  it('strips multiple meta blocks in one message', () => {
    const t =
      '안녕하세요!\n\nartifacts\n해당 세션에서 생성된 파일/링크: 없음\n\n가정\n사용자가 단순 인사로 메시지 주셨습니다.'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/artifacts/)
    expect(out).not.toMatch(/가정/)
    expect(out.trim()).toBe('안녕하세요!')
  })

  it('does NOT strip mid-paragraph mentions', () => {
    const t = 'The report has a Summary section at the end.'
    expect(stripMetaLabels(t)).toBe(t)
  })

  it('does NOT strip labels lacking colon/newline immediately after', () => {
    // "Summary of Q3" is a legitimate heading phrase, not a meta label.
    const t = 'Summary of Q3 sales performance.\n\nThe data shows growth.'
    const out = stripMetaLabels(t)
    expect(out).toMatch(/Summary of Q3/)
  })

  it('preserves artifact:// links inside substantive paragraphs', () => {
    const t =
      'Here is your report: [report.pdf](artifact://session/abc/artifacts/report.pdf)'
    const out = stripMetaLabels(t)
    expect(out).toMatch(/artifact:\/\/session/)
  })

  it('empty input', () => {
    expect(stripMetaLabels('')).toBe('')
  })

  // ── enumeration blocks (session 4a787313 style) ───────────────────────
  // When the Lead leaks a "첨부(다운로드)" or "참고(보조 자료)" section listing
  // artifact links, the UI's AttachmentStack already renders the files
  // below the message — the enumeration block in the prose is pure
  // redundancy and also visually weighs the message toward "여러 개 만들었네"
  // even when the extras are pdf-skill sidecars.

  it('strips "첨부(다운로드)" section with bullet list', () => {
    const t =
      '요청하신 보고서를 작성했습니다.\n\n첨부(다운로드)\n- [report.pdf](artifact://session/s1/artifacts/report.pdf)'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/첨부/)
    expect(out).toMatch(/작성했습니다/)
  })

  it('strips "참고(보조 자료)" section', () => {
    const t =
      '답변입니다.\n\n참고(보조 자료)\n- [data.csv](artifact://session/s1/artifacts/data.csv)'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/참고/)
  })

  it('strips "다운로드" header paragraph', () => {
    const t = 'Done.\n\n다운로드:\n- [x.pdf](artifact://…)'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/다운로드/)
  })

  it('strips English "Attachments" / "Downloads" / "Deliverables" sections', () => {
    const t =
      'Done.\n\nAttachments:\n- report.pdf\n\nDownloads\n- data.csv\n\nDeliverables:\n- final.docx'
    const out = stripMetaLabels(t)
    expect(out).not.toMatch(/Attachments/i)
    expect(out).not.toMatch(/Downloads/i)
    expect(out).not.toMatch(/Deliverables/i)
    expect(out.trim()).toBe('Done.')
  })

  it('does NOT strip "첨부" / "참고" mid-paragraph', () => {
    // These words appear in real prose; the heuristic only fires at
    // paragraph start followed by `:` `(` or newline.
    const t = '해당 자료를 첨부합니다. 참고 바랍니다.'
    expect(stripMetaLabels(t)).toBe(t)
  })
})

describe('stripFakeArtifactLinks', () => {
  const REAL = new Set([
    'artifact://session/s1/artifacts/report.pdf',
    'artifact://session/s1/artifacts/chart.png',
  ])

  it('keeps markdown links pointing at real artifacts', () => {
    const t = 'See [report](artifact://session/s1/artifacts/report.pdf) for details.'
    expect(stripFakeArtifactLinks(t, REAL)).toBe(t)
  })

  it('strips fake markdown links but preserves label', () => {
    const t = 'See [fake](artifact://session/s1/artifacts/nope.pdf) now.'
    expect(stripFakeArtifactLinks(t, REAL)).toBe('See [fake] now.')
  })

  it('strips bare fake URIs', () => {
    const t = 'Download artifact://session/s1/artifacts/nope.pdf now.'
    expect(stripFakeArtifactLinks(t, REAL)).toBe('Download  now.')
  })

  it('keeps bare real URIs', () => {
    const t = 'See artifact://session/s1/artifacts/report.pdf'
    expect(stripFakeArtifactLinks(t, REAL)).toBe(t)
  })

  it('handles mixed real + fake in one message', () => {
    const t = 'Real: [x](artifact://session/s1/artifacts/report.pdf) · Fake: [y](artifact://session/s1/artifacts/bogus.pdf)'
    expect(stripFakeArtifactLinks(t, REAL)).toBe(
      'Real: [x](artifact://session/s1/artifacts/report.pdf) · Fake: [y]',
    )
  })

  it('passes through text without any artifact URIs', () => {
    expect(stripFakeArtifactLinks('hello world', REAL)).toBe('hello world')
  })

  it('empty whitelist strips ALL artifact links (hallucination session)', () => {
    const t = '[a](artifact://session/x/artifacts/a.pdf) [b](artifact://session/x/artifacts/b.pdf)'
    const out = stripFakeArtifactLinks(t, new Set())
    expect(out).toBe('[a] [b]')
  })
})

describe('stripMetaLabelsStreaming', () => {
  async function* src(chunks: string[]) {
    for (const c of chunks) yield c
  }

  async function collect(it: AsyncIterable<string>): Promise<string> {
    let out = ''
    for await (const c of it) out += c
    return out
  }

  it('passes through clean streamed text', async () => {
    const out = await collect(
      stripMetaLabelsStreaming(src(['안녕', '하세요', ' — ', '어떻게 ', '도와드릴까요?'])),
    )
    expect(out).toMatch(/안녕하세요/)
    expect(out).toMatch(/도와드릴까요/)
  })

  it('strips a meta block arriving in multiple chunks', async () => {
    const out = await collect(
      stripMetaLabelsStreaming(
        src(['안녕하세요!\n\n', 'artifacts\n', '해당 세션에서 ', '생성된 파일: 없음']),
      ),
    )
    expect(out).not.toMatch(/artifacts/)
    expect(out).toMatch(/안녕하세요!/)
  })

  it('strips label block emitted all at once at end', async () => {
    const out = await collect(
      stripMetaLabelsStreaming(
        src(['결과입니다.\n\n가정: 기본값으로 처리했습니다.']),
      ),
    )
    expect(out).not.toMatch(/가정/)
    expect(out).toMatch(/결과입니다/)
  })
})
