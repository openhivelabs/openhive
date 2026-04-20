/**
 * Shared helpers for the NL→JSON generators (agents/generate, teams/generate).
 * Ports the skill-body loader + JSON extraction logic from
 * apps/server/openhive/api/{agents,teams}_generate.py.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { packagesRoot } from '../paths'

export function loadSkillBody(skillName: string): string {
  const file = path.join(packagesRoot(), 'skills', skillName, 'SKILL.md')
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`skill not found: ${file}`)
  }
  let text = fs.readFileSync(file, 'utf8')
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) {
      text = text.slice(end + '\n---'.length).replace(/^\n+/, '')
    }
  }
  return text
}

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

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'team'
}
