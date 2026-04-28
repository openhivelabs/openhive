import crypto from 'node:crypto'

export function extractJson(text: string): Record<string, unknown> {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) {
    throw new Error(`LLM did not return JSON. Got: ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(match[0]) as Record<string, unknown>
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc)
    throw new Error(`JSON parse failed: ${message}; raw: ${text.slice(0, 300)}`)
  }
}

export function rid(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(3).toString('hex')}`
}

function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'team'
}
