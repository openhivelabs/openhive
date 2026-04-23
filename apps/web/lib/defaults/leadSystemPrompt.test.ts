import { describe, it, expect } from 'vitest'
import { DEFAULT_LEAD_SYSTEM_PROMPT } from './leadSystemPrompt'

describe('DEFAULT_LEAD_SYSTEM_PROMPT', () => {
  const p = DEFAULT_LEAD_SYSTEM_PROMPT

  it('kept short (positive framing; avoid priming structured output)', () => {
    // Hard ceiling — the previous 2100-char prompt caused gpt-5-mini to emit
    // structured meta-labels (요약/가정/artifacts). Stay well under that. If
    // someone grows this past ~1200 chars, revisit whether the added rule is
    // essential or can live in a tool description instead.
    expect(p.length).toBeLessThan(1200)
  })

  it('persona + delegate intent', () => {
    expect(p).toMatch(/LEAD/)
    expect(p).toMatch(/delegate/i)
  })

  it('language continuity', () => {
    expect(p).toMatch(/language/i)
    expect(p).toMatch(/Match the user/i)
  })

  it('register: always formal with multi-language hints', () => {
    expect(p).toMatch(/formal.*professional register|formal \/ professional/i)
    expect(p).toMatch(/Korean.*존댓말/)
    expect(p).toMatch(/Japanese.*敬語/)
    expect(p).toMatch(/German.*Sie/)
  })

  it('style: plain prose, brevity-first (positive framing)', () => {
    expect(p).toMatch(/plain.*prose|conversational prose/i)
    expect(p).toMatch(/as short as|Stop when/i)
  })

  it('delegation: parallel via multiple delegate_to calls', () => {
    expect(p).toMatch(/multiple times in one turn|multiple.*delegate_to/i)
    expect(p).toMatch(/fit|cover/i)
  })

  it('ask_user as last resort', () => {
    expect(p).toMatch(/ask_user/i)
    expect(p).toMatch(/last resort|chain/i)
  })
})
