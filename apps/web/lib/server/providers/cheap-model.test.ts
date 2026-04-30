import { describe, expect, it } from 'vitest'
import { pickCheapModel } from './cheap-model'

describe('pickCheapModel', () => {
  it('returns null when nothing is connected', () => {
    expect(pickCheapModel([])).toBeNull()
  })

  it('prefers codex when present', () => {
    const choice = pickCheapModel(['anthropic', 'codex', 'gemini'])
    expect(choice).toEqual({ providerId: 'codex', model: 'gpt-5-mini' })
  })

  it('falls back to claude-code over copilot', () => {
    expect(pickCheapModel(['claude-code', 'copilot'])).toEqual({
      providerId: 'claude-code',
      model: 'claude-haiku-4-5',
    })
  })

  it('uses anthropic when only api_key is connected', () => {
    expect(pickCheapModel(['anthropic'])).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('picks gemini-3 flash for gemini', () => {
    expect(pickCheapModel(['gemini'])).toEqual({
      providerId: 'gemini',
      model: 'gemini-3-flash-preview',
    })
  })

  it('picks gemini flash for vertex-ai', () => {
    expect(pickCheapModel(['vertex-ai'])).toEqual({
      providerId: 'vertex-ai',
      model: 'gemini-3-flash-preview',
    })
  })

  it('falls back to copilot last', () => {
    expect(pickCheapModel(['copilot'])).toEqual({
      providerId: 'copilot',
      model: 'gpt-4o-mini',
    })
  })

  it('respects subscription priority — codex over openai api_key', () => {
    const choice = pickCheapModel(['openai', 'codex'])
    expect(choice?.providerId).toBe('codex')
  })
})
