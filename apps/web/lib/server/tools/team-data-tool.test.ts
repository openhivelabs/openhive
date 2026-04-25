import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolsManifest } from '../agents/loader'
import { teamDataTools } from './team-data-tool'

function manifest(overrides: Partial<ToolsManifest> = {}): ToolsManifest {
  return {
    skills: [],
    mcp_servers: [],
    team_data_read: true,
    team_data_write: true,
    team_data_ddl: true,
    team_data_allowed_tables: [],
    team_data_write_fields: [],
    team_data_templates: [],
    knowledge_exposure: 'full',
    notes: '',
    ...overrides,
  }
}

describe('db_describe', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-tdtool-'))
    process.env.OPENHIVE_DATA_DIR = tmp
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.OPENHIVE_DATA_DIR
  })

  it('reports empty: true + bootstrap hint for a new team', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const describe = tools.find((t) => t.name === 'db_describe')!
    const out = JSON.parse((await describe.handler({})) as string)
    expect(out.empty).toBe(true)
    expect(out.tables).toEqual([])
    expect(out.hint).toMatch(/design schema/i)
  })
})

describe('db_query permissions', () => {
  it('returns read_denied when team_data_read is false', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest({ team_data_read: false }))
    const q = tools.find((t) => t.name === 'db_query')!
    const out = JSON.parse((await q.handler({ sql: 'SELECT 1' })) as string)
    expect(out.ok).toBe(false)
    expect(out.error_code).toBe('read_denied')
  })

  it('rejects non-SELECT with not_a_select', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const q = tools.find((t) => t.name === 'db_query')!
    const out = JSON.parse((await q.handler({ sql: 'DELETE FROM x' })) as string)
    expect(out.ok).toBe(false)
    expect(out.error_code).toBe('not_a_select')
  })
})

describe('db_exec permissions + destructive gate', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-tdtool-'))
    process.env.OPENHIVE_DATA_DIR = tmp
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.OPENHIVE_DATA_DIR
  })

  it('write_denied when write=false for non-DDL', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest({ team_data_write: false, team_data_ddl: true }))
    const exec = tools.find((t) => t.name === 'db_exec')!
    // bootstrap a table first with ddl only
    await exec.handler({ sql: 'CREATE TABLE t (x INT)' })
    const out = JSON.parse((await exec.handler({ sql: 'INSERT INTO t (x) VALUES (1)' })) as string)
    expect(out.error_code).toBe('write_denied')
  })

  it('ddl_denied when ddl=false for CREATE', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest({ team_data_ddl: false }))
    const exec = tools.find((t) => t.name === 'db_exec')!
    const out = JSON.parse((await exec.handler({ sql: 'CREATE TABLE t (x INT)' })) as string)
    expect(out.error_code).toBe('ddl_denied')
  })

  it('needs_approval when ddl="ask"', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest({ team_data_ddl: 'ask' }))
    const exec = tools.find((t) => t.name === 'db_exec')!
    const out = JSON.parse((await exec.handler({ sql: 'CREATE TABLE t (x INT)' })) as string)
    expect(out.error_code).toBe('needs_approval')
  })

  it('destructive_unconfirmed without confirm flag', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const exec = tools.find((t) => t.name === 'db_exec')!
    await exec.handler({ sql: 'CREATE TABLE t (x INT)' })
    const out = JSON.parse((await exec.handler({ sql: 'DROP TABLE t' })) as string)
    expect(out.error_code).toBe('destructive_unconfirmed')
  })

  it('runs destructive with confirm_destructive: true', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const exec = tools.find((t) => t.name === 'db_exec')!
    await exec.handler({ sql: 'CREATE TABLE t (x INT)' })
    const out = JSON.parse(
      (await exec.handler({ sql: 'DROP TABLE t', confirm_destructive: true })) as string,
    )
    expect(out.ok).toBe(true)
    expect(out.ddl).toBe(true)
  })

  it('binds params', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const exec = tools.find((t) => t.name === 'db_exec')!
    const q = tools.find((t) => t.name === 'db_query')!
    await exec.handler({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)' })
    await exec.handler({ sql: 'INSERT INTO t (name) VALUES (?)', params: ['Alice'] })
    const out = JSON.parse(
      (await q.handler({ sql: 'SELECT name FROM t WHERE name = ?', params: ['Alice'] })) as string,
    )
    expect(out.rows).toEqual([{ name: 'Alice' }])
  })

  it('rejects multi_statement', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const exec = tools.find((t) => t.name === 'db_exec')!
    const out = JSON.parse(
      (await exec.handler({ sql: 'CREATE TABLE a(x INT); CREATE TABLE b(y INT)' })) as string,
    )
    expect(out.error_code).toBe('multi_statement')
  })
})

describe('db_explain', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-tdtool-'))
    process.env.OPENHIVE_DATA_DIR = tmp
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.OPENHIVE_DATA_DIR
  })

  it('returns a plan for a SELECT', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const exec = tools.find((t) => t.name === 'db_exec')!
    const explain = tools.find((t) => t.name === 'db_explain')!
    await exec.handler({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, x INT)' })
    const out = JSON.parse(
      (await explain.handler({ sql: 'SELECT * FROM t WHERE x = 1' })) as string,
    )
    expect(out.ok).toBe(true)
    expect(Array.isArray(out.plan)).toBe(true)
  })

  it('rejects non-SELECT', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const explain = tools.find((t) => t.name === 'db_explain')!
    const out = JSON.parse(
      (await explain.handler({ sql: 'DELETE FROM t' })) as string,
    )
    expect(out.error_code).toBe('not_a_select')
  })
})

describe('db_install_template', () => {
  let tmp: string
  let tmpl: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-tdtool-'))
    tmpl = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-tmpl-'))
    fs.mkdirSync(path.join(tmpl, 'crm'))
    fs.writeFileSync(
      path.join(tmpl, 'crm', 'install.sql'),
      'CREATE TABLE leads (id INTEGER PRIMARY KEY);',
    )
    process.env.OPENHIVE_DATA_DIR = tmp
    process.env.OPENHIVE_TEMPLATES_DIR = tmpl
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(tmpl, { recursive: true, force: true })
    delete process.env.OPENHIVE_DATA_DIR
    delete process.env.OPENHIVE_TEMPLATES_DIR
  })

  it('denies templates not in whitelist', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest({ team_data_templates: ['inbox'] }))
    const t = tools.find((x) => x.name === 'db_install_template')!
    const out = JSON.parse((await t.handler({ template_name: 'crm' })) as string)
    expect(out.error_code).toBe('unknown_template')
  })

  it('installs whitelisted template', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest({ team_data_templates: ['crm'] }))
    const t = tools.find((x) => x.name === 'db_install_template')!
    const out = JSON.parse((await t.handler({ template_name: 'crm' })) as string)
    expect(out.ok).toBe(true)
    expect(out.tables_created).toContain('leads')
  })
})

describe('db_read_guide', () => {
  it('rejects unknown topic', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const t = tools.find((x) => x.name === 'db_read_guide')!
    const out = JSON.parse((await t.handler({ topic: 'bogus' })) as string)
    expect(out.error_code).toBe('unknown_topic')
    expect(out.valid).toContain('hybrid-schema')
  })

  it('returns markdown for a known topic', async () => {
    const tools = teamDataTools('acme', 'team-sales', manifest())
    const t = tools.find((x) => x.name === 'db_read_guide')!
    const out = JSON.parse((await t.handler({ topic: 'hybrid-schema' })) as string)
    expect(out.ok).toBe(true)
    expect(out.content).toMatch(/hybrid/i)
  })
})
