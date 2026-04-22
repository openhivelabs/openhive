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
