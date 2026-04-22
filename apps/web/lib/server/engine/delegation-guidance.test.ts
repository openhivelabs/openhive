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
  it('lists multi-interpretation precondition', () => {
    expect(g).toMatch(/INCOMPATIBLE/)
  })
  it('lists NOT-to-use greetings / tone / defaults', () => {
    expect(g).toMatch(/ㅎㅇ|안녕|hi/i)
    expect(g).toMatch(/tone|격식/i)
    expect(g).toMatch(/default|기본|markdown/i)
  })
  it('forbids chaining across turns', () => {
    expect(g).toMatch(/chain|consecutive/i)
  })
  it('instructs bundling into one call', () => {
    expect(g).toMatch(/bundle.*one call|ONE call/i)
  })
})

describe('delegateToGuidance', () => {
  const g = delegateToGuidance()
  it('mentions Goal / Context / Deliverable / Scope fence', () => {
    expect(g).toMatch(/\*\*Goal\*\*/)
    expect(g).toMatch(/\*\*Context\*\*/)
    expect(g).toMatch(/\*\*Deliverable\*\*/)
    expect(g).toMatch(/\*\*Scope fence\*\*/)
  })
  it('states never delegate understanding', () => {
    expect(g).toMatch(/Never delegate understanding/i)
  })
  it('describes multiple-calls parallel pattern', () => {
    expect(g).toMatch(/MULTIPLE times|call .* multiple times/i)
    expect(g).toMatch(/parallel|concurrently/i)
  })
  it('mentions artifact citation requirement', () => {
    expect(g).toMatch(/artifact:\/\/|artifact/i)
  })
})

describe('activateSkillGuidance', () => {
  const g = activateSkillGuidance()
  it('describes activation effects', () => {
    expect(g).toMatch(/SKILL\.md|guide/i)
  })
  it('recommends lazy activation', () => {
    expect(g).toMatch(/lazy|only when/i)
  })
})
