import { describe, it, expect } from 'vitest'
import { stripMetaLabels, stripMetaLabelsStreaming } from './post-process'

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
