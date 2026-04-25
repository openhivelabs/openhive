import { describe, expect, it } from 'vitest'
import {
  COUPLED_SKILL_GROUPS,
  resolveEffectiveSkills,
  roleDefaultSkills,
} from './skill-bundles'

describe('roleDefaultSkills', () => {
  it('gives Lead the research bundle (search + fetch)', () => {
    const out = roleDefaultSkills('Lead')
    expect(out).toContain('web-search')
    expect(out).toContain('web-fetch')
  })

  it('is case-insensitive and tolerant of separators', () => {
    expect(roleDefaultSkills('researcher-latest')).toContain('web-search')
    expect(roleDefaultSkills('Research Verifier')).toContain('web-search')
    expect(roleDefaultSkills('PRESENTATION_DESIGNER')).toContain('pdf')
  })

  it('returns [] for unknown roles (no implicit grants)', () => {
    expect(roleDefaultSkills('zorblax-the-magnificent')).toEqual([])
  })

  it('Member generalist has research + doc + media bundles', () => {
    const out = roleDefaultSkills('Member')
    expect(out).toContain('web-search')
    expect(out).toContain('pdf')
    expect(out).toContain('image-gen')
  })
})

describe('resolveEffectiveSkills — coupling', () => {
  it('reproduces the original bug input and FIXES it: declared web-fetch pulls in web-search', () => {
    // The exact persona declaration from the broken session.
    const out = resolveEffectiveSkills({
      role: 'Member',
      personaSkills: [],
      nodeSkills: ['pdf', 'docx', 'pptx', 'image-gen', 'text-file', 'web-fetch'],
      allowedSkills: [],
    })
    expect(out).toContain('web-search')
    expect(out).toContain('web-fetch')
  })

  it('adds web-fetch when only web-search is declared (group is bidirectional)', () => {
    const out = resolveEffectiveSkills({
      role: 'unknown',
      nodeSkills: ['web-search'],
    })
    expect(out).toContain('web-fetch')
  })

  it('does not add coupled skills when nothing in the group is present', () => {
    const out = resolveEffectiveSkills({
      role: 'unknown',
      nodeSkills: ['pdf'],
    })
    expect(out).not.toContain('web-search')
    expect(out).not.toContain('web-fetch')
    expect(COUPLED_SKILL_GROUPS.length).toBeGreaterThan(0)
  })
})

describe('resolveEffectiveSkills — composition', () => {
  it('unions role defaults + persona + node skills, deduplicated', () => {
    const out = resolveEffectiveSkills({
      role: 'Lead',
      personaSkills: ['pdf'],
      nodeSkills: ['pdf', 'docx'],
    })
    expect(out).toContain('web-search') // from role default
    expect(out).toContain('pdf') // de-duplicated
    expect(out).toContain('docx')
    expect(out.filter((s) => s === 'pdf').length).toBe(1)
  })

  it('does NOT fall back to "all skills" when nothing is declared (the dead footgun)', () => {
    const out = resolveEffectiveSkills({
      role: 'no-such-role',
      personaSkills: [],
      nodeSkills: [],
    })
    expect(out).toEqual([])
  })

  it('narrows by team allow-list when non-empty', () => {
    const out = resolveEffectiveSkills({
      role: 'Member',
      allowedSkills: ['pdf', 'web-search'],
    })
    // Member default is research+doc+media but team only allows two.
    expect(out.sort()).toEqual(['pdf', 'web-search'].sort())
  })

  it('empty allow-list = no narrowing', () => {
    const out = resolveEffectiveSkills({
      role: 'Lead',
      allowedSkills: [],
    })
    expect(out).toContain('web-search')
  })

  it('coupling runs BEFORE allow-list narrowing — allow-list still wins', () => {
    // If team explicitly forbids web-search, coupling must not sneak it in.
    const out = resolveEffectiveSkills({
      role: 'unknown',
      nodeSkills: ['web-fetch'],
      allowedSkills: ['web-fetch'],
    })
    expect(out).toEqual(['web-fetch'])
  })
})
