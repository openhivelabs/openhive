/**
 * SQLite access for the TS backend. Schema mirrors apps/server/openhive/
 * persistence/db.py exactly — during migration both runtimes read/write the
 * same file (~/.openhive/openhive.db), so the two schemas MUST stay in sync.
 *
 * Singleton pattern: cached on globalThis so Next.js HMR doesn't leak handles.
 */

import Database from 'better-sqlite3'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { dbPath } from './paths'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider_id   TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  account_label TEXT,
  account_id    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  text          TEXT NOT NULL,
  session_id    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_team_created
  ON messages(team_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT,
  team_id       TEXT NOT NULL,
  goal          TEXT NOT NULL,
  status        TEXT NOT NULL,
  output        TEXT,
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_team_started ON sessions(team_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);

CREATE TABLE IF NOT EXISTS session_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  ts            REAL NOT NULL,
  kind          TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,
  node_id       TEXT,
  tool_call_id  TEXT,
  tool_name     TEXT,
  data_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_events_session_seq ON session_events(session_id, seq);

CREATE TABLE IF NOT EXISTS usage_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  session_id        TEXT,
  company_id        TEXT,
  team_id           TEXT,
  agent_id          TEXT,
  agent_role        TEXT,
  provider_id       TEXT NOT NULL,
  model             TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_cents    REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_logs(ts);
CREATE INDEX IF NOT EXISTS idx_usage_company_ts ON usage_logs(company_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_team_ts ON usage_logs(team_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_agent_ts ON usage_logs(agent_id, ts);

CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  team_id       TEXT NOT NULL,
  company_slug  TEXT,
  team_slug     TEXT,
  skill_name    TEXT,
  filename      TEXT NOT NULL,
  path          TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_team_created
  ON artifacts(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_session
  ON artifacts(session_id);

CREATE TABLE IF NOT EXISTS panel_cache (
  panel_id     TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  data_json    TEXT,
  error        TEXT,
  fetched_at   INTEGER NOT NULL,
  duration_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_panel_cache_team ON panel_cache(team_id);
`

interface DbCache {
  conn?: BetterSqliteDatabase
}

const globalForDb = globalThis as unknown as { __openhive_db?: DbCache }

function tableExists(conn: BetterSqliteDatabase, name: string): boolean {
  const row = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function tableColumns(conn: BetterSqliteDatabase, table: string): Set<string> {
  if (!tableExists(conn, table)) return new Set()
  const cols = conn
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[]
  return new Set(cols.map((c) => c.name))
}

function migrateRunsToSessions(conn: BetterSqliteDatabase): void {
  const hasRuns = tableExists(conn, 'runs')
  const runCols = tableColumns(conn, 'runs')
  const hasSessionUuid = runCols.has('session_uuid')

  conn.transaction(() => {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        task_id       TEXT,
        team_id       TEXT NOT NULL,
        goal          TEXT NOT NULL,
        status        TEXT NOT NULL,
        output        TEXT,
        error         TEXT,
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER
      );
      CREATE TABLE IF NOT EXISTS session_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        seq           INTEGER NOT NULL,
        ts            REAL NOT NULL,
        kind          TEXT NOT NULL,
        depth         INTEGER NOT NULL DEFAULT 0,
        node_id       TEXT,
        tool_call_id  TEXT,
        tool_name     TEXT,
        data_json     TEXT
      );
    `)

    if (hasRuns && hasSessionUuid) {
      const taskExpr = runCols.has('task_id') ? 'task_id' : 'NULL AS task_id'
      conn.exec(`
        INSERT OR IGNORE INTO sessions
          (id, task_id, team_id, goal, status, output, error, started_at, finished_at)
        SELECT session_uuid, ${taskExpr}, team_id, goal, status, output, error,
               started_at, finished_at
          FROM runs
         WHERE session_uuid IS NOT NULL
      `)

      for (const table of ['messages', 'usage_logs', 'artifacts']) {
        const cols = tableColumns(conn, table)
        if (cols.has('run_id') && !cols.has('session_id')) {
          conn.exec(`
            UPDATE ${table}
               SET run_id = (
                 SELECT session_uuid FROM runs WHERE runs.id = ${table}.run_id
               )
             WHERE run_id IS NOT NULL
               AND run_id IN (SELECT id FROM runs WHERE session_uuid IS NOT NULL)
          `)
          conn.exec(`
            DELETE FROM ${table}
             WHERE run_id IS NOT NULL
               AND run_id NOT IN (SELECT session_uuid FROM runs WHERE session_uuid IS NOT NULL)
          `)
          conn.exec(`ALTER TABLE ${table} RENAME COLUMN run_id TO session_id`)
        }
      }

      if (tableExists(conn, 'run_events')) {
        conn.exec(`
          INSERT INTO session_events
            (session_id, seq, ts, kind, depth, node_id, tool_call_id, tool_name, data_json)
          SELECT runs.session_uuid, run_events.seq, run_events.ts, run_events.kind,
                 run_events.depth, run_events.node_id, run_events.tool_call_id,
                 run_events.tool_name, run_events.data_json
            FROM run_events
            JOIN runs ON runs.id = run_events.run_id
           WHERE runs.session_uuid IS NOT NULL
        `)
        conn.exec('DROP TABLE run_events')
      }
    } else {
      for (const table of ['messages', 'usage_logs', 'artifacts']) {
        const cols = tableColumns(conn, table)
        if (cols.has('run_id') && !cols.has('session_id')) {
          conn.exec(`ALTER TABLE ${table} RENAME COLUMN run_id TO session_id`)
        }
      }
      if (tableExists(conn, 'run_events')) conn.exec('DROP TABLE run_events')
    }

    if (hasRuns) conn.exec('DROP TABLE runs')
  })()
}

function initConnection(file: string): BetterSqliteDatabase {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const conn = new Database(file)
  // Same pragmas as the Python side — WAL, relaxed sync for bursty streaming,
  // 5s busy wait so concurrent readers don't deadlock the writer.
  conn.pragma('journal_mode = WAL')
  conn.pragma('synchronous = NORMAL')
  conn.pragma('busy_timeout = 5000')
  conn.pragma('temp_store = MEMORY')
  conn.pragma('foreign_keys = ON')
  migrateRunsToSessions(conn)
  conn.exec(SCHEMA)
  // Idempotent migration to match Python's init_db — older DBs may lack
  // account_id. Both runtimes perform the same check.
  const cols = conn
    .prepare('PRAGMA table_info(oauth_tokens)')
    .all() as { name: string }[]
  if (!cols.some((c) => c.name === 'account_id')) {
    conn.exec('ALTER TABLE oauth_tokens ADD COLUMN account_id TEXT')
  }
  // Phase G1: char-count breakdown of the prompt payload per call.
  // Lets us attribute input-token spend to system/tools/history regions.
  const usageCols = conn
    .prepare('PRAGMA table_info(usage_logs)')
    .all() as { name: string }[]
  const usageColSet = new Set(usageCols.map((c) => c.name))
  if (!usageColSet.has('system_chars')) {
    conn.exec('ALTER TABLE usage_logs ADD COLUMN system_chars INTEGER DEFAULT 0')
  }
  if (!usageColSet.has('tools_chars')) {
    conn.exec('ALTER TABLE usage_logs ADD COLUMN tools_chars INTEGER DEFAULT 0')
  }
  if (!usageColSet.has('history_chars')) {
    conn.exec('ALTER TABLE usage_logs ADD COLUMN history_chars INTEGER DEFAULT 0')
  }
  return conn
}

export function getDb(): BetterSqliteDatabase {
  if (!globalForDb.__openhive_db) {
    globalForDb.__openhive_db = {}
  }
  const cache = globalForDb.__openhive_db
  if (!cache.conn || !cache.conn.open) {
    cache.conn = initConnection(dbPath())
  }
  return cache.conn
}

/** Force-reopen the DB. Useful after restoring from backup or in tests. */
export function reopenDb(): void {
  const cache = globalForDb.__openhive_db
  if (cache?.conn?.open) cache.conn.close()
  if (cache) cache.conn = undefined
}
