import { describe, it, expect } from 'vitest'
import { DEFAULT_AGENT_SKILLS } from './skills'

describe('DEFAULT_AGENT_SKILLS', () => {
  it('includes the 6 utility skills a fresh team needs for file/image/web work', () => {
    // Regression guard — every name here must match a directory under
    // packages/skills/ with a valid SKILL.md. If someone renames a skill,
    // they must update this list too.
    expect(DEFAULT_AGENT_SKILLS).toContain('pdf')
    expect(DEFAULT_AGENT_SKILLS).toContain('docx')
    expect(DEFAULT_AGENT_SKILLS).toContain('pptx')
    expect(DEFAULT_AGENT_SKILLS).toContain('image-gen')
    expect(DEFAULT_AGENT_SKILLS).toContain('text-file')
    expect(DEFAULT_AGENT_SKILLS).toContain('web-fetch')
  })

  it('has no duplicate entries', () => {
    const set = new Set(DEFAULT_AGENT_SKILLS)
    expect(set.size).toBe(DEFAULT_AGENT_SKILLS.length)
  })

  it('all names are skill-id safe (lowercase, hyphens, no spaces)', () => {
    for (const n of DEFAULT_AGENT_SKILLS) {
      expect(n).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })
})
