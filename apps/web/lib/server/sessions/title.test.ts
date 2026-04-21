import { describe, expect, it } from 'vitest'

import { generateTitle } from './title'

describe('generateTitle', () => {
  it('trims, sanitizes quotes, and caps to 10 words', async () => {
    const complete = async () =>
      '  "Weekly market report for Q3 semiconductor research and trends and outlook extra words"  '
    const title = await generateTitle('Write the weekly market report', 'en', {
      complete,
    })
    expect(title).not.toBeNull()
    expect(title!.startsWith('"')).toBe(false)
    expect(title!.endsWith('"')).toBe(false)
    const words = title!.split(' ')
    expect(words.length).toBeLessThanOrEqual(10)
    expect(words.length).toBeGreaterThanOrEqual(6)
    expect(title!).toBe(
      'Weekly market report for Q3 semiconductor research and trends and',
    )
  })

  it('drops trailing sentence punctuation', async () => {
    const complete = async () => 'Plan the Q3 semiconductor research report.'
    const title = await generateTitle('some goal', 'en', { complete })
    expect(title).toBe('Plan the Q3 semiconductor research report')
  })

  it('returns null when provider throws', async () => {
    const complete = async () => {
      throw new Error('boom — 401 unauthorized')
    }
    const title = await generateTitle('Build a market dashboard', 'en', {
      complete,
    })
    expect(title).toBeNull()
  })

  it('returns null for an empty or blank goal without calling the provider', async () => {
    let called = 0
    const complete = async () => {
      called += 1
      return 'should not run'
    }
    expect(await generateTitle('', 'en', { complete })).toBeNull()
    expect(await generateTitle('   \n\t', 'en', { complete })).toBeNull()
    expect(called).toBe(0)
  })

  it('returns null when the provider times out', async () => {
    const complete = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve('too late'), 50))
    const title = await generateTitle('Draft a report', 'en', {
      complete,
      timeoutMs: 5,
    })
    expect(title).toBeNull()
  })

  it('returns null when the provider yields an empty/whitespace response', async () => {
    const complete = async () => '   \n  '
    expect(
      await generateTitle('Draft a plan', 'en', { complete }),
    ).toBeNull()
  })

  it('honors ko locale by forwarding it to the completion fn', async () => {
    let seenLocale: string | null = null
    const complete = async (_goal: string, locale: 'en' | 'ko') => {
      seenLocale = locale
      return '분기별 반도체 시장 동향 보고서 작성'
    }
    const title = await generateTitle('반도체 시장 보고서 작성', 'ko', {
      complete,
    })
    expect(seenLocale).toBe('ko')
    expect(title).toBe('분기별 반도체 시장 동향 보고서 작성')
  })
})
