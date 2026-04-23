import { describe, it, expect } from 'vitest'
import {
  askUserGuidance,
  delegateToGuidance,
  activateSkillGuidance,
} from './delegation-guidance'

describe('askUserGuidance', () => {
  const g = askUserGuidance()

  it('states LAST RESORT framing', () => {
    expect(g).toMatch(/LAST RESORT/)
  })

  it('lists 4-part precheck including no-chaining', () => {
    expect(g).toMatch(/INCOMPATIBLE/)
    expect(g).toMatch(/never chain/i)
  })

  it('lists NOT-reasons (greetings / tone / defaults)', () => {
    expect(g).toMatch(/greeting/i)
    expect(g).toMatch(/tone|register/i)
    expect(g).toMatch(/default format/i)
  })

  it('bundles questions into one call', () => {
    expect(g).toMatch(/bundle.*ONE call|ONE call/i)
  })

  it("defers to system prompt for full policy (stays terse)", () => {
    expect(g).toMatch(/system prompt/i)
  })
})

describe('delegateToGuidance', () => {
  const g = delegateToGuidance()

  it('mentions briefing 4-part discipline', () => {
    expect(g).toMatch(/\*\*Goal\*\*/)
    expect(g).toMatch(/\*\*Context\*\*/)
    expect(g).toMatch(/\*\*Deliverable\*\*/)
    expect(g).toMatch(/\*\*Scope fence\*\*/)
  })

  it('forbids delegating understanding', () => {
    expect(g).toMatch(/Never delegate understanding/i)
  })

  it('describes multiple-calls parallel pattern', () => {
    expect(g).toMatch(/MULTIPLE times/i)
    expect(g).toMatch(/parallel|concurrently|fan out/i)
  })

  it('instructs reading subordinate assumption + citing artifacts', () => {
    expect(g).toMatch(/Assumption/)
    expect(g).toMatch(/artifact:\/\//)
  })
})

describe('activateSkillGuidance', () => {
  const g = activateSkillGuidance()

  it('describes load-guide + lazy activation', () => {
    expect(g).toMatch(/SKILL\.md|guide/i)
    expect(g).toMatch(/lazy|only when/i)
  })
})
