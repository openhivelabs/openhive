/**
 * Per-company ledger DB connection cache.
 *
 * CLAUDE.md rule: long-lived state lives on `globalThis` under a Symbol.for()
 * key so Vite HMR / tsx watch don't create duplicate handles.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { companyDir } from '../paths'
import { LEDGER_SCHEMA_V1 } from './schema'

const LEDGER_DB_KEY = Symbol.for('openhive.ledger.dbCache')

interface LedgerCache {
  conns: Map<string, BetterSqliteDatabase>
  shutdownRegistered: boolean
}

function cache(): LedgerCache {
  const g = globalThis as unknown as Record<symbol, LedgerCache | undefined>
  let c = g[LEDGER_DB_KEY]
  if (!c) {
    c = { conns: new Map(), shutdownRegistered: false }
    g[LEDGER_DB_KEY] = c
  }
  return c
}

export function ledgerDir(companySlug: string): string {
  // Respect OPENHIVE_DATA_DIR the same way team-data.ts does, so tests that
  // swap tmp dirs per-test aren't pinned to the cached settings value.
  const envRoot = process.env.OPENHIVE_DATA_DIR
  if (envRoot) {
    return path.join(envRoot, 'companies', companySlug, 'ledger')
  }
  return path.join(companyDir(companySlug), 'ledger')
}

function ledgerDbPath(companySlug: string): string {
  return path.join(ledgerDir(companySlug), 'index.db')
}

function ensureSchema(db: BetterSqliteDatabase): void {
  db.exec(LEDGER_SCHEMA_V1)
  const existing = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get()
  if (!existing) {
    db.prepare('INSERT INTO schema_migrations (applied_at, version, note) VALUES (?, 1, ?)').run(
      Date.now(),
      'initial',
    )
  }
}

function open(companySlug: string): BetterSqliteDatabase {
  fs.mkdirSync(ledgerDir(companySlug), { recursive: true })
  const db = new Database(ledgerDbPath(companySlug))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  ensureSchema(db)
  return db
}

export function isLedgerDisabled(): boolean {
  return process.env.OPENHIVE_LEDGER_DISABLED === '1'
}

/**
 * Run `fn` with a cached SQLite handle for the given company. Creates the
 * ledger directory + DB on first call. Throws if ledger is disabled via env.
 */
export function withLedgerDb<T>(companySlug: string, fn: (db: BetterSqliteDatabase) => T): T {
  if (isLedgerDisabled()) {
    throw new Error('ledger disabled (OPENHIVE_LEDGER_DISABLED=1)')
  }
  const c = cache()
  // Cache key includes data dir so per-test tmpdirs don't collide across runs.
  const key = `${process.env.OPENHIVE_DATA_DIR ?? ''}::${companySlug}`
  let conn = c.conns.get(key)
  if (!conn) {
    conn = open(companySlug)
    c.conns.set(key, conn)
  }
  if (!c.shutdownRegistered) {
    c.shutdownRegistered = true
    const closeAll = (): void => {
      for (const db of c.conns.values()) {
        try {
          db.close()
        } catch {
          /* ignore */
        }
      }
      c.conns.clear()
    }
    process.once('SIGTERM', closeAll)
    process.once('SIGINT', closeAll)
    process.once('beforeExit', closeAll)
  }
  return fn(conn)
}

/** Test helper — close + drop the cached connection for a company. */
export function __resetLedgerCache(): void {
  const c = cache()
  for (const db of c.conns.values()) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
  c.conns.clear()
}
