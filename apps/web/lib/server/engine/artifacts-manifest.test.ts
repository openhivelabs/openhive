import { describe, it, expect } from 'vitest'
import {
  renderDelegationArtifacts,
  appendArtifactBlock,
  renderSessionArtifacts,
  type ManifestEntry,
} from './artifacts-manifest'

describe('renderDelegationArtifacts', () => {
  it('returns empty string for empty input', () => {
    expect(renderDelegationArtifacts([])).toBe('')
  })
  it('wraps paths in <delegation-artifacts> block', () => {
    const out = renderDelegationArtifacts([
      'artifact://session/s1/artifacts/a.pdf',
      'artifact://session/s1/artifacts/b.png',
    ])
    expect(out).toContain('<delegation-artifacts>')
    expect(out).toContain('</delegation-artifacts>')
    expect(out).toContain('- artifact://session/s1/artifacts/a.pdf')
    expect(out).toContain('- artifact://session/s1/artifacts/b.png')
  })
})

describe('appendArtifactBlock', () => {
  it('returns body unchanged if no paths', () => {
    expect(appendArtifactBlock('hello', [])).toBe('hello')
    expect(appendArtifactBlock('hello', undefined)).toBe('hello')
  })
  it('appends block after body', () => {
    const out = appendArtifactBlock('hello', [
      'artifact://session/s1/artifacts/a.pdf',
    ])
    const bodyIdx = out.indexOf('hello')
    const blockIdx = out.indexOf('<delegation-artifacts>')
    expect(bodyIdx).toBe(0)
    expect(blockIdx).toBeGreaterThan(bodyIdx)
  })
})

describe('renderSessionArtifacts', () => {
  it('returns empty string when list empty', () => {
    expect(renderSessionArtifacts([])).toBe('')
  })
  it('wraps in <session-artifacts> with must-cite directive', () => {
    const entries: ManifestEntry[] = [
      {
        uri: 'artifact://session/s1/artifacts/a.pdf',
        filename: 'a.pdf',
        producer: 'researcher',
        createdAt: 1000,
      },
    ]
    const out = renderSessionArtifacts(entries)
    expect(out).toContain('<session-artifacts>')
    expect(out).toContain('</session-artifacts>')
    expect(out).toContain('artifact://session/s1/artifacts/a.pdf')
    expect(out).toMatch(/cite|인용/i)
    expect(out).toMatch(/MUST|반드시/i)
  })
  it('orders by createdAt ascending', () => {
    const entries: ManifestEntry[] = [
      {
        uri: 'artifact://x/b',
        filename: 'b',
        producer: 'p',
        createdAt: 200,
      },
      {
        uri: 'artifact://x/a',
        filename: 'a',
        producer: 'p',
        createdAt: 100,
      },
    ]
    const out = renderSessionArtifacts(entries)
    expect(out.indexOf('artifact://x/a')).toBeLessThan(
      out.indexOf('artifact://x/b'),
    )
  })
})
