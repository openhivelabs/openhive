-- CRM template install script.
-- Idempotent — safe to run multiple times. The outer install_template()
-- wraps this in a transaction.

CREATE TABLE IF NOT EXISTS customer (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  stage       TEXT DEFAULT 'lead',
  value       REAL DEFAULT 0,
  owner       TEXT,
  created_at  INTEGER,
  updated_at  INTEGER,
  data        TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_customer_stage ON customer(stage);
CREATE INDEX IF NOT EXISTS idx_customer_email ON customer(email);

CREATE TABLE IF NOT EXISTS activity (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  body         TEXT,
  created_at   INTEGER NOT NULL,
  data         TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_activity_customer ON activity(customer_id, created_at);
