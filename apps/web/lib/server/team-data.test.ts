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

describe('single-statement guard', () => {
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-td-'))
    process.env.OPENHIVE_DATA_DIR = tmp
  })

  it('rejects multiple statements in runQuery', () => {
    expect(() =>
      runQuery('acme', 'sales', 'SELECT 1; SELECT 2'),
    ).toThrow(/multi_statement/)
  })

  it('rejects multiple statements in runExec', () => {
    expect(() =>
      runExec('acme', 'sales', 'CREATE TABLE a(x INT); CREATE TABLE b(y INT)'),
    ).toThrow(/multi_statement/)
  })

  it('allows trailing semicolon + whitespace', () => {
    runExec('acme', 'sales', 'CREATE TABLE t (x INT);  \n  ')
    const r = runQuery('acme', 'sales', 'SELECT name FROM sqlite_master WHERE type = ? ;', {
      params: ['table'],
    })
    expect(r.rows.some((r) => (r as { name: string }).name === 't')).toBe(true)
  })

  it('ignores trailing comments', () => {
    runExec('acme', 'sales', 'CREATE TABLE t (x INT); -- done')
    runExec('acme', 'sales', 'CREATE TABLE u (y INT); /* trailing block */')
  })
})

import { isDestructiveSql } from './team-data'

describe('isDestructiveSql', () => {
  it('flags DROP TABLE / DROP INDEX / TRUNCATE', () => {
    expect(isDestructiveSql('DROP TABLE leads')).toBe(true)
    expect(isDestructiveSql('drop index ix_leads_name')).toBe(true)
    expect(isDestructiveSql('TRUNCATE TABLE leads')).toBe(true)
  })

  it('flags DELETE / UPDATE without WHERE', () => {
    expect(isDestructiveSql('DELETE FROM leads')).toBe(true)
    expect(isDestructiveSql('UPDATE leads SET score = 0')).toBe(true)
  })

  it('passes DELETE / UPDATE with WHERE', () => {
    expect(isDestructiveSql('DELETE FROM leads WHERE id = 1')).toBe(false)
    expect(isDestructiveSql("UPDATE leads SET score = 0 WHERE status = 'cold'")).toBe(false)
  })

  it('strips comments before checking', () => {
    expect(isDestructiveSql('DELETE FROM leads -- WHERE id = 1')).toBe(true)
    expect(isDestructiveSql('DELETE FROM leads /* WHERE id = 1 */')).toBe(true)
  })

  it('ignores CREATE / ALTER / INSERT / SELECT', () => {
    expect(isDestructiveSql('CREATE TABLE t (x INT)')).toBe(false)
    expect(isDestructiveSql('ALTER TABLE t ADD COLUMN y TEXT')).toBe(false)
    expect(isDestructiveSql('INSERT INTO t VALUES (1)')).toBe(false)
    expect(isDestructiveSql('SELECT * FROM t')).toBe(false)
  })
})

describe('query timeout', () => {
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-td-'))
    process.env.OPENHIVE_DATA_DIR = tmp
    process.env.OPENHIVE_DB_QUERY_TIMEOUT_MS = '50'
  })

  afterEach(() => {
    delete process.env.OPENHIVE_DB_QUERY_TIMEOUT_MS
  })

  it('interrupts a long-running recursive CTE', () => {
    const sql =
      'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 99999999) SELECT count(*) FROM c'
    expect(() => runQuery('acme', 'sales', sql)).toThrow(/timeout/)
  })
})
