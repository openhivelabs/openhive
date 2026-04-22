import { describe, expect, it } from 'vitest'

import { globToRegex, matchHooks, matchesGlob } from './matcher'
import type { HookEntry } from './types'

describe('globToRegex', () => {
  it('matches literal names', () => {
    expect(globToRegex('sql_exec').test('sql_exec')).toBe(true)
    expect(globToRegex('sql_exec').test('sql_execute')).toBe(false)
  })

  it('matches star prefix', () => {
    expect(matchesGlob('sql_*', 'sql_exec')).toBe(true)
    expect(matchesGlob('sql_*', 'sql_query')).toBe(true)
    expect(matchesGlob('sql_*', 'mcp__sql_exec')).toBe(false)
  })

  it('matches mcp-style nested prefix', () => {
    expect(matchesGlob('mcp__brave__*', 'mcp__brave__search')).toBe(true)
    expect(matchesGlob('mcp__brave__*', 'mcp__brave_search')).toBe(false)
    expect(matchesGlob('mcp__*__write*', 'mcp__github__write_file')).toBe(true)
  })

  it('star alone matches everything', () => {
    expect(matchesGlob('*', 'anything')).toBe(true)
    expect(matchesGlob('*', '')).toBe(true)
  })

  it('escapes regex metacharacters', () => {
    expect(matchesGlob('a.b+c', 'a.b+c')).toBe(true)
    expect(matchesGlob('a.b+c', 'aXb+c')).toBe(false)
    expect(matchesGlob('foo(bar)', 'foo(bar)')).toBe(true)
    expect(matchesGlob('pkg[1]', 'pkg[1]')).toBe(true)
  })

  it('question-mark matches exactly one char', () => {
    expect(matchesGlob('foo?', 'fooa')).toBe(true)
    expect(matchesGlob('foo?', 'foo')).toBe(false)
    expect(matchesGlob('foo?', 'foobar')).toBe(false)
  })
})

describe('matchHooks', () => {
  const mk = (matcher: string, command = '/usr/bin/true'): HookEntry => ({
    matcher,
    command,
    timeout: 1000,
  })

  it('returns empty when no entries', () => {
    expect(matchHooks('PreToolUse', 'sql_exec', [])).toEqual([])
  })

  it('filters to matching matchers only', () => {
    const entries = [mk('sql_*'), mk('delegate_to'), mk('*')]
    const out = matchHooks('PreToolUse', 'sql_exec', entries)
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.matcher)).toEqual(['sql_*', '*'])
  })

  it('preserves declaration order', () => {
    const entries = [mk('*'), mk('sql_*'), mk('sql_exec')]
    const out = matchHooks('PreToolUse', 'sql_exec', entries)
    expect(out.map((e) => e.matcher)).toEqual(['*', 'sql_*', 'sql_exec'])
  })

  it('empty string target matches * but not literal', () => {
    const entries = [mk('*'), mk('acme')]
    const out = matchHooks('SessionStart', '', entries)
    expect(out).toHaveLength(1)
    expect(out[0]?.matcher).toBe('*')
  })
})
