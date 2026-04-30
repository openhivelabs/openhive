import { describe, expect, it } from 'vitest'
import { ProviderError, classifyProviderError, redactCredentials } from './errors'

describe('redactCredentials', () => {
  it('redacts Anthropic api keys in free text', () => {
    expect(redactCredentials('leak sk-ant-api03-aBc1234567890DEFghijklmno fail')).toBe(
      'leak sk-ant-*** fail',
    )
  })

  it('redacts OpenAI sk-proj keys', () => {
    expect(redactCredentials('use sk-proj-aBcDeFgH1234567890zYxWvUt')).toBe('use sk-proj-***')
  })

  it('redacts plain OpenAI sk- keys', () => {
    expect(redactCredentials('legacy sk-aB1234567890CDef5678gHIj')).toBe('legacy sk-***')
  })

  it('redacts Gemini AIza keys', () => {
    expect(redactCredentials('header AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz_-12345')).toBe(
      'header AIza***',
    )
  })

  it('redacts ya29 access tokens', () => {
    // ya29 pattern matches the token; bearer header line pattern needs a colon.
    expect(redactCredentials('saw ya29.aBcDef-_1234567890 ok')).toBe('saw ya29.*** ok')
  })

  it('redacts authorization header line (preserving header-name casing)', () => {
    expect(redactCredentials('Authorization: Bearer ya29.aBcDef')).toBe('Authorization: ***')
  })

  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nABCDEFGH\n-----END PRIVATE KEY-----'
    expect(redactCredentials(`leak: ${pem}`)).toBe('leak: -----PRIVATE_KEY_REDACTED-----')
  })

  it('redacts header lines case-insensitively (preserves original case in name)', () => {
    expect(redactCredentials('x-api-key: sk-ant-api03-foo')).toBe('x-api-key: ***')
    // The capture group preserves the original casing — so "X-Goog-Api-Key" stays.
    expect(redactCredentials('X-Goog-Api-Key: AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX-x')).toBe(
      'X-Goog-Api-Key: ***',
    )
  })

  it('passes through clean text', () => {
    expect(redactCredentials('hello world')).toBe('hello world')
  })
})

describe('classifyProviderError', () => {
  it('returns auth on 401', () => {
    const err = classifyProviderError({ status: 401, body: 'unauthorized', providerId: 'anthropic' })
    expect(err.kind).toBe('auth')
    expect(err.userMessage).toBe('error.provider.auth')
    expect(err.providerId).toBe('anthropic')
  })

  it('returns geo_restricted on 403 with region keyword', () => {
    const err = classifyProviderError({
      status: 403,
      body: 'Service is not available in your country',
      providerId: 'gemini',
    })
    expect(err.kind).toBe('geo_restricted')
  })

  it('returns quota on 429', () => {
    const err = classifyProviderError({ status: 429, body: 'rate limit', providerId: 'openai' })
    expect(err.kind).toBe('quota')
  })

  it('returns quota when body says insufficient_quota even on 200-ish', () => {
    const err = classifyProviderError({ status: 400, body: 'insufficient_quota detected' })
    expect(err.kind).toBe('quota')
  })

  it('returns unsupported_model on 404', () => {
    const err = classifyProviderError({ status: 404, body: 'model not found' })
    expect(err.kind).toBe('unsupported_model')
  })

  it('returns transient on 500/0', () => {
    expect(classifyProviderError({ status: 500, body: 'oops' }).kind).toBe('transient')
    expect(classifyProviderError({ status: 0, body: 'network' }).kind).toBe('transient')
  })

  it('redacts the underlying message body', () => {
    const err = classifyProviderError({
      status: 401,
      body: 'auth failed for sk-ant-api03-aBc1234567890DEFghij',
    })
    expect(err.message).not.toContain('sk-ant-api03-aBc')
    expect(err.message).toContain('sk-ant-***')
  })
})

describe('ProviderError', () => {
  it('redacts message during construction', () => {
    const err = new ProviderError({
      kind: 'auth',
      userMessage: 'error.provider.auth',
      message: 'header AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz_-12345 leaked',
    })
    expect(err.message).toContain('AIza***')
    expect(err.message).not.toContain('AIzaSyAbC')
  })
})
