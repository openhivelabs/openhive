import { describe, expect, it } from 'vitest'
import { capMcpBody } from './manager'

describe('capMcpBody', () => {
  it('returns body unchanged when under cap', () => {
    const body = 'a'.repeat(100)
    expect(capMcpBody(body)).toBe(body)
  })

  it('caps body just under threshold', () => {
    const body = 'a'.repeat(20_000)
    expect(capMcpBody(body)).toBe(body)
  })

  it('truncates and appends hint when over cap', () => {
    const body = 'x'.repeat(30_000)
    const out = capMcpBody(body)
    expect(out.startsWith('x'.repeat(20_000))).toBe(true)
    expect(out).toContain('[openhive:mcp-truncated]')
    expect(out).toContain('30000 chars')
  })

  it('preserves head content exactly', () => {
    const head = 'HEAD_MARKER_START'
    const body = head + 'y'.repeat(25_000)
    const out = capMcpBody(body)
    expect(out.startsWith(head)).toBe(true)
  })
})
