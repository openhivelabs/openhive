import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runExec, runQuery } from './team-data'

describe('team-data params', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-td-'))
    process.env.OPENHIVE_DATA_DIR = tmp
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.OPENHIVE_DATA_DIR
  })

  it('binds ? parameters in runQuery', () => {
    runExec('acme', 'sales', 'CREATE TABLE leads (id INTEGER PRIMARY KEY, name TEXT)')
    runExec('acme', 'sales', "INSERT INTO leads (name) VALUES ('Alice')", { params: [] })
    runExec('acme', 'sales', 'INSERT INTO leads (name) VALUES (?)', { params: ['Bob'] })
    const r = runQuery('acme', 'sales', 'SELECT name FROM leads WHERE name = ?', {
      params: ['Bob'],
    })
    expect(r.rows).toEqual([{ name: 'Bob' }])
  })

  it('accepts numeric and null params', () => {
    runExec('acme', 'sales', 'CREATE TABLE t (a INTEGER, b TEXT)')
    runExec('acme', 'sales', 'INSERT INTO t (a, b) VALUES (?, ?)', { params: [1, null] })
    const r = runQuery('acme', 'sales', 'SELECT * FROM t WHERE a = ?', { params: [1] })
    expect(r.rows).toEqual([{ a: 1, b: null }])
  })
})
