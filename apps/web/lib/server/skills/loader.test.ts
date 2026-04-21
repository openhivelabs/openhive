import { describe, expect, it } from 'vitest'
import { matchSkillHints, type SkillDef } from './loader'

const skill = (
  name: string,
  triggers?: SkillDef['triggers'],
  description = '',
): SkillDef => ({
  name,
  description,
  kind: 'agent',
  skillDir: `/tmp/${name}`,
  source: 'bundled',
  triggers,
})

describe('matchSkillHints', () => {
  it('returns empty array when no skills have triggers', () => {
    expect(
      matchSkillHints('PDF 보고서 만들어줘', [skill('pdf'), skill('docx')]),
    ).toEqual([])
  })

  it('matches by case-insensitive keyword', () => {
    const pdf = skill('pdf', { keywords: ['PDF', '보고서'] })
    const docx = skill('docx', { keywords: ['Word', 'docx'] })
    const hits = matchSkillHints('pdf 한장 만들어줘', [pdf, docx])
    expect(hits.map((s) => s.name)).toEqual(['pdf'])
  })

  it('matches by regex pattern (case-insensitive)', () => {
    const pptx = skill('pptx', { patterns: ['\\b(slides?|deck|PPTX)\\b'] })
    const hits = matchSkillHints('Build a 10-slide deck', [pptx])
    expect(hits).toHaveLength(1)
  })

  it('ignores invalid regex sources without throwing', () => {
    const bad = skill('bad', { patterns: ['(unclosed'] })
    expect(() => matchSkillHints('text', [bad])).not.toThrow()
    expect(matchSkillHints('text', [bad])).toEqual([])
  })

  it('returns multiple matches in input order', () => {
    const a = skill('a', { keywords: ['alpha'] })
    const b = skill('b', { keywords: ['beta'] })
    const c = skill('c', { keywords: ['gamma'] })
    const hits = matchSkillHints('alpha and beta are here', [a, b, c])
    expect(hits.map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('deduplicates — a skill with both keyword and pattern match still returns once', () => {
    const s = skill('one', { keywords: ['alpha'], patterns: ['alpha'] })
    const hits = matchSkillHints('alpha', [s])
    expect(hits).toHaveLength(1)
  })
})
