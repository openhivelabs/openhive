import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolsManifest } from '../agents/loader'
import { teamDataTools } from './team-data-tool'

const fullManifest: ToolsManifest = {
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
}

describe('db-skill end-to-end', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-e2e-'))
    process.env.OPENHIVE_DATA_DIR = tmp
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.OPENHIVE_DATA_DIR
  })

  it('bootstrap empty → design schema → insert → query → EXPLAIN → destructive gated DROP', async () => {
    const tools = teamDataTools(['acme', 'sales'], fullManifest)
    const describe = tools.find((t) => t.name === 'db_describe')!
    const exec = tools.find((t) => t.name === 'db_exec')!
    const query = tools.find((t) => t.name === 'db_query')!
    const explain = tools.find((t) => t.name === 'db_explain')!

    // 1. empty DB
    const init = JSON.parse((await describe.handler({})) as string)
    expect(init.empty).toBe(true)
    expect(init.hint).toBeDefined()

    // 2. design schema
    const ddl = JSON.parse(
      (await exec.handler({
        sql:
          "CREATE TABLE inbox (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, priority TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT (unixepoch()))",
        note: 'initial inbox table',
      })) as string,
    )
    expect(ddl.ok).toBe(true)
    expect(ddl.ddl).toBe(true)

    // 3. insert with params
    const ins = JSON.parse(
      (await exec.handler({
        sql: 'INSERT INTO inbox (subject, priority) VALUES (?, ?)',
        params: ['Welcome', 'high'],
      })) as string,
    )
    expect(ins.rows_changed).toBe(1)

    // 4. query
    const q = JSON.parse(
      (await query.handler({
        sql: 'SELECT subject, priority FROM inbox WHERE priority = ?',
        params: ['high'],
      })) as string,
    )
    expect(q.rows).toEqual([{ subject: 'Welcome', priority: 'high' }])
    expect(typeof q.elapsed_ms).toBe('number')

    // 5. explain
    const plan = JSON.parse(
      (await explain.handler({ sql: 'SELECT * FROM inbox WHERE priority = ?', params: ['high'] })) as string,
    )
    expect(plan.ok).toBe(true)

    // 6. destructive DROP gated
    const dropGuarded = JSON.parse(
      (await exec.handler({ sql: 'DROP TABLE inbox' })) as string,
    )
    expect(dropGuarded.error_code).toBe('destructive_unconfirmed')

    // 7. destructive DROP allowed with confirm
    const dropped = JSON.parse(
      (await exec.handler({ sql: 'DROP TABLE inbox', confirm_destructive: true })) as string,
    )
    expect(dropped.ok).toBe(true)

    // 8. describe shows empty again
    const after = JSON.parse((await describe.handler({})) as string)
    expect(after.empty).toBe(true)

    // 9. data.db file exists on disk
    const dbFile = path.join(tmp, 'companies', 'acme', 'teams', 'sales', 'data.db')
    expect(fs.existsSync(dbFile)).toBe(true)
  })
})
