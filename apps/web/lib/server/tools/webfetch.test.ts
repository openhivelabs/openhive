import { describe, expect, it } from 'vitest'
import { capText, htmlToText, isPrivateUrl, webFetchTool } from './webfetch'

describe('isPrivateUrl', () => {
  it('rejects non-http schemes', () => {
    expect(isPrivateUrl('file:///etc/passwd')).toBe(true)
    expect(isPrivateUrl('ftp://example.com/x')).toBe(true)
  })

  it('rejects localhost and loopback', () => {
    expect(isPrivateUrl('http://localhost/')).toBe(true)
    expect(isPrivateUrl('http://127.0.0.1/')).toBe(true)
    expect(isPrivateUrl('http://0.0.0.0/')).toBe(true)
  })

  it('rejects private IPv4 ranges', () => {
    expect(isPrivateUrl('http://10.0.0.1/')).toBe(true)
    expect(isPrivateUrl('http://192.168.1.1/')).toBe(true)
    expect(isPrivateUrl('http://172.16.0.1/')).toBe(true)
    expect(isPrivateUrl('http://169.254.169.254/')).toBe(true)
  })

  it('accepts public hosts', () => {
    expect(isPrivateUrl('https://example.com/')).toBe(false)
    expect(isPrivateUrl('http://93.184.216.34/')).toBe(false)
  })

  it('rejects malformed URLs', () => {
    expect(isPrivateUrl('not a url')).toBe(true)
    expect(isPrivateUrl('')).toBe(true)
  })
})

describe('htmlToText', () => {
  it('strips tags and decodes common entities', () => {
    const out = htmlToText('<p>Hello <b>&amp; world</b></p>')
    expect(out).toBe('Hello & world')
  })

  it('removes script and style blocks wholesale', () => {
    const out = htmlToText(
      '<script>alert(1)</script><p>Kept</p><style>a{}</style>',
    )
    expect(out).not.toContain('alert')
    expect(out).not.toContain('a{}')
    expect(out).toContain('Kept')
  })

  it('converts block boundaries to newlines', () => {
    const out = htmlToText('<p>one</p><p>two</p>')
    expect(out).toContain('one')
    expect(out).toContain('two')
    expect(out.split('\n').length).toBeGreaterThanOrEqual(2)
  })
})

describe('capText', () => {
  it('returns unchanged when under cap', () => {
    expect(capText('short', 5)).toBe('short')
  })

  it('appends truncation marker over cap', () => {
    const big = 'x'.repeat(25_000)
    const out = capText(big, 25_000)
    expect(out).toContain('[openhive:webfetch-truncated]')
    expect(out.startsWith('x'.repeat(20_000))).toBe(true)
  })
})

describe('webFetchTool', () => {
  it('exposes the expected metadata', () => {
    const t = webFetchTool()
    expect(t.name).toBe('web_fetch')
    expect(t.parameters).toMatchObject({
      type: 'object',
      required: ['url'],
    })
  })

  it('rejects missing url before touching fetch', async () => {
    const t = webFetchTool()
    const result = await t.handler({}) as string
    expect(result).toContain('missing url')
  })

  it('rejects private URL before touching fetch', async () => {
    const t = webFetchTool()
    const result = await t.handler({ url: 'http://localhost/' }) as string
    expect(result).toContain('URL rejected')
  })
})
