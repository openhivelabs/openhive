/**
 * Provider error normalization.
 *
 * All adapters catch upstream HTTP/network errors and throw `ProviderError`
 * so the engine can render a localized message and the UI can show a
 * provider-specific toast. Credentials are redacted from messages and
 * stack traces before they ever reach logs or the wire.
 */

export type ProviderErrorKind =
  | 'auth' // 401/403
  | 'quota' // 429 with persistent failure / billing
  | 'unsupported_model' // 404 model not found
  | 'geo_restricted' // 403 with region indicator
  | 'transient' // 5xx, network, timeout
  | 'unknown'

const REDACT_PATTERNS: [RegExp, string][] = [
  [/sk-ant-api[0-9]+-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***'],
  [/sk-proj-[A-Za-z0-9_-]{20,}/g, 'sk-proj-***'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-***'],
  [/AIza[A-Za-z0-9_-]{35}/g, 'AIza***'],
  [/ya29\.[A-Za-z0-9_-]+/g, 'ya29.***'],
  [/-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA )?PRIVATE KEY-----/g, '-----PRIVATE_KEY_REDACTED-----'],
  // Header lines that may carry secrets (Authorization, x-api-key, x-goog-api-key).
  // Matches the value after the colon up to the next CRLF / line end.
  [/(authorization|x-api-key|x-goog-api-key)\s*:\s*[^\r\n]+/gi, '$1: ***'],
]

export function redactCredentials(text: string): string {
  let out = text
  for (const [re, replacement] of REDACT_PATTERNS) out = out.replace(re, replacement)
  return out
}

export class ProviderError extends Error {
  public readonly kind: ProviderErrorKind
  /** i18n key for UI display (e.g. `error.provider.auth`). */
  public readonly userMessage: string
  /** Provider id ('anthropic', 'codex', ...) for routing in the engine error handler. */
  public readonly providerId: string | undefined
  /** HTTP status if available; 0 for network/abort errors. */
  public readonly status: number
  public override readonly cause?: unknown

  constructor(opts: {
    kind: ProviderErrorKind
    userMessage: string
    message: string
    providerId?: string
    status?: number
    cause?: unknown
  }) {
    super(redactCredentials(opts.message))
    this.name = 'ProviderError'
    this.kind = opts.kind
    this.userMessage = opts.userMessage
    this.providerId = opts.providerId
    this.status = opts.status ?? 0
    this.cause = opts.cause
  }
}

interface ClassifyInput {
  status: number
  body: string
  providerId?: string
  cause?: unknown
}

/** Map an upstream HTTP response (or thrown error) to a `ProviderError`. */
export function classifyProviderError(input: ClassifyInput): ProviderError {
  const { status, body, providerId, cause } = input
  const lower = body.toLowerCase()

  if (status === 401 || status === 403) {
    if (lower.includes('region') || lower.includes('country') || lower.includes('not available in')) {
      return new ProviderError({
        kind: 'geo_restricted',
        userMessage: 'error.provider.geo_restricted',
        message: `${providerId ?? 'provider'} ${status}: ${body.slice(0, 200)}`,
        providerId,
        status,
        cause,
      })
    }
    return new ProviderError({
      kind: 'auth',
      userMessage: 'error.provider.auth',
      message: `${providerId ?? 'provider'} ${status}: ${body.slice(0, 200)}`,
      providerId,
      status,
      cause,
    })
  }

  if (status === 429 || lower.includes('insufficient_quota') || lower.includes('credit balance')) {
    return new ProviderError({
      kind: 'quota',
      userMessage: 'error.provider.quota',
      message: `${providerId ?? 'provider'} quota: ${body.slice(0, 200)}`,
      providerId,
      status,
      cause,
    })
  }

  if (status === 404 || lower.includes('model') && lower.includes('not found')) {
    return new ProviderError({
      kind: 'unsupported_model',
      userMessage: 'error.provider.unsupported_model',
      message: `${providerId ?? 'provider'} model not found: ${body.slice(0, 200)}`,
      providerId,
      status,
      cause,
    })
  }

  if (status === 0 || (status >= 500 && status < 600)) {
    return new ProviderError({
      kind: 'transient',
      userMessage: 'error.provider.transient',
      message: `${providerId ?? 'provider'} transient ${status}: ${body.slice(0, 200)}`,
      providerId,
      status,
      cause,
    })
  }

  return new ProviderError({
    kind: 'unknown',
    userMessage: 'error.provider.transient',
    message: `${providerId ?? 'provider'} ${status}: ${body.slice(0, 200)}`,
    providerId,
    status,
    cause,
  })
}
