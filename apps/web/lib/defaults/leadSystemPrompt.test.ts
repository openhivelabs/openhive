import { describe, it, expect } from 'vitest'
import { DEFAULT_LEAD_SYSTEM_PROMPT } from './leadSystemPrompt'

describe('DEFAULT_LEAD_SYSTEM_PROMPT', () => {
  const p = DEFAULT_LEAD_SYSTEM_PROMPT
  it('persona + delegate intent', () => {
    expect(p).toMatch(/LEAD/)
    expect(p).toMatch(/delegate/i)
    expect(p).toMatch(/synthes/i)
  })
  it('language continuity', () => {
    expect(p).toMatch(/language they used/i)
    expect(p).toMatch(/한국어/)
  })
  it('ask_user last resort rule', () => {
    expect(p).toMatch(/LAST RESORT/)
    expect(p).toMatch(/ㅎㅇ|greeting/)
    expect(p).toMatch(/chain|consecutive/)
  })
  it('artifact citation obligation', () => {
    expect(p).toMatch(/artifact:\/\//)
    expect(p).toMatch(/MUST cite/)
    expect(p).toMatch(/session-artifacts|delegation-artifacts/)
  })
  it('fit-check then self-fallback', () => {
    expect(p).toMatch(/role or skillset actually cover/)
    expect(p).toMatch(/answer yourself/)
  })
  it('parallel via multiple delegate_to calls', () => {
    expect(p).toMatch(/MULTIPLE times in one turn/)
  })
  it('briefing discipline', () => {
    expect(p).toMatch(/\*\*Goal\*\*/)
    expect(p).toMatch(/\*\*Deliverable\*\*/)
    expect(p).toMatch(/\*\*Scope fence\*\*/)
  })
  it('subordinate assumption pattern', () => {
    expect(p).toMatch(/가정:/)
    expect(p).toMatch(/self-resolve/i)
  })
})
