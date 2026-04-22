import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadPersonaFromPath } from './loader'

describe('tools.yaml team_data extensions', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-persona-'))
    fs.writeFileSync(path.join(dir, 'AGENT.md'), '# Hi')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('parses ddl: true and templates list', () => {
    fs.writeFileSync(
      path.join(dir, 'tools.yaml'),
      'team_data:\n  read: true\n  write: true\n  ddl: true\n  templates:\n    - crm\n    - inbox\n',
    )
    const p = loadPersonaFromPath(dir)!
    expect(p.tools.team_data_read).toBe(true)
    expect(p.tools.team_data_write).toBe(true)
    expect(p.tools.team_data_ddl).toBe(true)
    expect(p.tools.team_data_templates).toEqual(['crm', 'inbox'])
  })

  it('parses "ask" for write and ddl', () => {
    fs.writeFileSync(
      path.join(dir, 'tools.yaml'),
      'team_data:\n  write: ask\n  ddl: ask\n',
    )
    const p = loadPersonaFromPath(dir)!
    expect(p.tools.team_data_write).toBe('ask')
    expect(p.tools.team_data_ddl).toBe('ask')
  })

  it('defaults ddl to false when absent', () => {
    fs.writeFileSync(path.join(dir, 'tools.yaml'), 'team_data:\n  read: true\n')
    const p = loadPersonaFromPath(dir)!
    expect(p.tools.team_data_ddl).toBe(false)
    expect(p.tools.team_data_templates).toEqual([])
  })
})
