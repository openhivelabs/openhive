import { describe, it, expect } from 'vitest'
import { DEFAULT_LEAD_SYSTEM_PROMPT } from './leadSystemPrompt'

describe('DEFAULT_LEAD_SYSTEM_PROMPT', () => {
  const p = DEFAULT_LEAD_SYSTEM_PROMPT

  it('persona + delegate intent', () => {
    expect(p).toMatch(/LEAD/)
    expect(p).toMatch(/delegate/i)
    expect(p).toMatch(/synthes/i)
  })

  it('language: reply in user language, no code-switching', () => {
    expect(p).toMatch(/language/i)
    expect(p).toMatch(/code-switch/i)
  })

  it('register: always formal, multi-language examples', () => {
    expect(p).toMatch(/formal.*professional register|most formal/i)
    expect(p).toMatch(/Korean.*존댓말/)
    expect(p).toMatch(/Japanese.*敬語|Japanese.*です/)
    expect(p).toMatch(/German.*Sie/)
    expect(p).toMatch(/French.*vous/)
  })

  it('register applies regardless of user input register', () => {
    expect(p).toMatch(/regardless of how informally/i)
  })

  it('ask_user last-resort rule', () => {
    expect(p).toMatch(/LAST RESORT/)
    expect(p).toMatch(/chain|consecutive/i)
    expect(p).toMatch(/greeting/i)
  })

  it('artifact citation: only when relevant, no empty placeholder', () => {
    expect(p).toMatch(/artifact:\/\//)
    expect(p).toMatch(/if no artifacts exist|DO NOT mention artifacts/i)
    expect(p).toMatch(/placeholder|없음|No artifacts produced/)
  })

  it('fit-check then self-fallback', () => {
    expect(p).toMatch(/role or skillset actually cover/)
    expect(p).toMatch(/answer yourself/i)
  })

  it('parallel via multiple delegate_to calls in one turn', () => {
    expect(p).toMatch(/MULTIPLE times in one turn/i)
  })

  it('briefing discipline (Goal/Context/Deliverable/Scope fence)', () => {
    expect(p).toMatch(/\*\*Goal\*\*/)
    expect(p).toMatch(/\*\*Context\*\*/)
    expect(p).toMatch(/\*\*Deliverable\*\*/)
    expect(p).toMatch(/\*\*Scope fence\*\*/)
  })

  it('trivial vs substantive response shape split', () => {
    expect(p).toMatch(/trivial conversational turns/i)
    expect(p).toMatch(/substantive deliveries/i)
    expect(p).toMatch(/ONE short sentence|short paragraph/i)
  })

  it('forbids meta-labels in output', () => {
    expect(p).toMatch(/meta-label/i)
    // Representative labels — must be called out explicitly
    expect(p).toMatch(/요약:/)
    expect(p).toMatch(/가정:/)
    expect(p).toMatch(/artifacts:/)
    expect(p).toMatch(/Summary:/)
  })

  it('no revision menus / trailers', () => {
    expect(p).toMatch(/revision menu|Finish cleanly/i)
  })
})
