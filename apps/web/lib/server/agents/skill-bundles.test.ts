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
    const out = resolveEffectiveSkills({
      role: 'Member',
      personaSkills: [],
      nodeSkills: ['pdf', 'docx', 'pptx', 'image-gen', 'text-file', 'web-fetch'],
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

  it('coupling fires from bundledSkills too (filesystem-discovered web-fetch pulls web-search)', () => {
    const out = resolveEffectiveSkills({
      role: 'unknown',
      bundledSkills: ['web-fetch'],
    })
    expect(out).toContain('web-search')
  })
})

describe('resolveEffectiveSkills — composition', () => {
  it('unions role defaults + persona + node + bundled, deduplicated', () => {
    const out = resolveEffectiveSkills({
      role: 'Lead',
      personaSkills: ['pdf'],
      nodeSkills: ['pdf', 'docx'],
      bundledSkills: ['xlsx', 'pdf'],
    })
    expect(out).toContain('web-search')
    expect(out).toContain('pdf')
    expect(out).toContain('docx')
    expect(out).toContain('xlsx')
    expect(out.filter((s) => s === 'pdf').length).toBe(1)
  })

  it('returns [] when nothing declared and no bundled provided (no implicit grants)', () => {
    const out = resolveEffectiveSkills({
      role: 'no-such-role',
      personaSkills: [],
      nodeSkills: [],
    })
    expect(out).toEqual([])
  })
})

describe('resolveEffectiveSkills — bundled (filesystem source of truth)', () => {
  it('every bundled skill is visible by default', () => {
    const out = resolveEffectiveSkills({
      role: 'Lead',
      bundledSkills: ['xlsx', 'docx', 'pptx', 'pdf'],
    })
    expect(out).toContain('xlsx')
    expect(out).toContain('docx')
    expect(out).toContain('pptx')
    expect(out).toContain('pdf')
  })

  it('ignores legacy allowed_skills field (no positive whitelist enforcement)', () => {
    // Even if a TeamSpec still carries the legacy 7-entry allowed_skills,
    // it is no longer passed into the resolver — bundled skills come through.
    const out = resolveEffectiveSkills({
      role: 'Lead',
      bundledSkills: ['xlsx', 'pdf', 'docx'],
    })
    expect(out).toContain('xlsx')
  })
})

describe('resolveEffectiveSkills — disabled (denylist)', () => {
  it('removes any skill listed in disabledSkills', () => {
    const out = resolveEffectiveSkills({
      role: 'Lead',
      bundledSkills: ['xlsx', 'pdf', 'db'],
      disabledSkills: ['xlsx'],
    })
    expect(out).not.toContain('xlsx')
    expect(out).toContain('pdf')
    expect(out).toContain('db')
  })

  it('disabledSkills overrides coupling — explicitly forbidden web-search stays out', () => {
    const out = resolveEffectiveSkills({
      role: 'unknown',
      nodeSkills: ['web-fetch'],
      disabledSkills: ['web-search'],
    })
    expect(out).toContain('web-fetch')
    expect(out).not.toContain('web-search')
  })

  it('empty disabledSkills = no removal', () => {
    const out = resolveEffectiveSkills({
      role: 'Lead',
      bundledSkills: ['xlsx'],
      disabledSkills: [],
    })
    expect(out).toContain('xlsx')
  })
})
