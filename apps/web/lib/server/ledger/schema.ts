/**
 * Work ledger schema (S4). Cross-session operational history per company.
 *
 * See dev/active/runtime-claude-patterns/s4-work-ledger.md §2 for rationale.
 * This schema constant is consumed by `db.ts` on first open; migrations are
 * tracked in `schema_migrations` with an integer version so future ALTERs
 * stay idempotent.
 */

export const LEDGER_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL UNIQUE,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id              TEXT PRIMARY KEY,
  ts              INTEGER NOT NULL,
  session_id      TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  agent_role      TEXT NOT NULL,
  domain          TEXT NOT NULL,
  task            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  artifact_paths  TEXT NOT NULL,
  body_path       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('completed','errored','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_entries_ts        ON entries(ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_team_ts   ON entries(team_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_agent_ts  ON entries(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_domain_ts ON entries(domain, ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_session   ON entries(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  task,
  summary,
  domain,
  agent_role,
  content=entries,
  content_rowid=rowid,
  tokenize='unicode61 remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, task, summary, domain, agent_role)
  VALUES (new.rowid, new.task, new.summary, new.domain, new.agent_role);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, task, summary, domain, agent_role)
  VALUES ('delete', old.rowid, old.task, old.summary, old.domain, old.agent_role);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, task, summary, domain, agent_role)
  VALUES ('delete', old.rowid, old.task, old.summary, old.domain, old.agent_role);
  INSERT INTO entries_fts(rowid, task, summary, domain, agent_role)
  VALUES (new.rowid, new.task, new.summary, new.domain, new.agent_role);
END;
`
