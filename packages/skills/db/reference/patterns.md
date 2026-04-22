# Common SQLite patterns

Recipes for problems that come up in every per-team DB: upsert, soft-delete,
full-text search, time-series rollups, audit trails, pagination. Each is
idiomatic SQLite — no PostgreSQL-isms.

## Upsert (`ON CONFLICT ... DO UPDATE`)

SQLite has true UPSERT since 3.24. Use it — don't emulate with
`INSERT OR REPLACE`, which deletes-and-reinserts the row (breaking FKs,
losing unchanged column values, bumping rowid).

```sql
INSERT INTO leads (email, name, status)
VALUES (?, ?, ?)
    ON CONFLICT (email) DO UPDATE SET
       name       = excluded.name,
       status     = excluded.status,
       updated_at = unixepoch();
```

`excluded` is the magic pseudo-table holding the values that would have been
inserted. Pair with a `UNIQUE` constraint (or `PRIMARY KEY`) on the conflict
column — `ON CONFLICT` needs something to conflict with.

## Soft delete

Keep a `deleted_at INTEGER` column, null by default, filled with
`unixepoch()` when the row is "removed":

```sql
ALTER TABLE leads ADD COLUMN deleted_at INTEGER;

-- Delete:
UPDATE leads SET deleted_at = unixepoch() WHERE id = ?;

-- All read queries:
SELECT * FROM leads WHERE deleted_at IS NULL AND ...;
```

Pair with a partial index so the live-row queries stay fast even when the
trash grows:

```sql
CREATE INDEX ix_leads_live ON leads (id) WHERE deleted_at IS NULL;
```

For a hard purge, a periodic `DELETE FROM leads WHERE deleted_at < unixepoch() - 86400*30`
run behind the destructive-DDL gate is fine.

## FTS5 full-text search

`FTS5` is a virtual-table module for fast text search. The idiomatic setup
uses an external-content table so the FTS index mirrors the main table:

```sql
CREATE VIRTUAL TABLE leads_fts USING fts5(
  name, notes,
  content = 'leads',
  content_rowid = 'id'
);

-- Keep it in sync with triggers:
CREATE TRIGGER leads_ai AFTER INSERT ON leads BEGIN
  INSERT INTO leads_fts (rowid, name, notes)
  VALUES (new.id, new.name, json_extract(new.data, '$.notes'));
END;

CREATE TRIGGER leads_ad AFTER DELETE ON leads BEGIN
  INSERT INTO leads_fts (leads_fts, rowid, name, notes)
  VALUES ('delete', old.id, old.name, json_extract(old.data, '$.notes'));
END;

CREATE TRIGGER leads_au AFTER UPDATE ON leads BEGIN
  INSERT INTO leads_fts (leads_fts, rowid, name, notes)
  VALUES ('delete', old.id, old.name, json_extract(old.data, '$.notes'));
  INSERT INTO leads_fts (rowid, name, notes)
  VALUES (new.id, new.name, json_extract(new.data, '$.notes'));
END;
```

Search with the MATCH operator:

```sql
SELECT l.*
  FROM leads_fts f
  JOIN leads l ON l.id = f.rowid
 WHERE leads_fts MATCH ?
 ORDER BY rank
 LIMIT 20;
```

Use tokens like `acme NEAR/3 contract` and `"exact phrase"` in the MATCH
expression; FTS5 handles ranking via the hidden `rank` column.

## Time-series rollup

For dashboards, keep a pre-aggregated summary table instead of recomputing
from the raw log every render:

```sql
CREATE TABLE rollup_daily (
  day   TEXT PRIMARY KEY,       -- 'YYYY-MM-DD' UTC
  total INTEGER NOT NULL DEFAULT 0
);

-- Every time an event lands, bump the bucket:
INSERT INTO rollup_daily (day, total)
VALUES (strftime('%Y-%m-%d', unixepoch(), 'unixepoch'), 1)
    ON CONFLICT (day) DO UPDATE SET total = total + excluded.total;
```

You can do this in application code after every insert, or via an
`AFTER INSERT` trigger on the raw table. Reconcile periodically from the
source of truth if the counter drifts.

## Audit trail

Cheap, append-only audit table + a trigger per watched table:

```sql
CREATE TABLE audit (
  id         INTEGER PRIMARY KEY,
  table_name TEXT    NOT NULL,
  row_id     INTEGER NOT NULL,
  op         TEXT    NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  at         INTEGER NOT NULL DEFAULT (unixepoch()),
  before     TEXT,                          -- JSON snapshot
  after      TEXT                           -- JSON snapshot
);

CREATE TRIGGER leads_audit_u AFTER UPDATE ON leads BEGIN
  INSERT INTO audit (table_name, row_id, op, before, after) VALUES (
    'leads', old.id, 'UPDATE',
    json_object('name', old.name, 'status', old.status, 'data', old.data),
    json_object('name', new.name, 'status', new.status, 'data', new.data)
  );
END;
```

Add `INSERT` / `DELETE` variants as needed. For a low-churn table this is
essentially free; for a high-churn table consider sampling or only auditing
specific columns.

## Pagination — prefer keyset over OFFSET

`LIMIT ? OFFSET ?` gets slower as the offset grows because SQLite still
walks the skipped rows. Use keyset (a.k.a. seek-method) pagination:

```sql
-- First page:
SELECT id, name FROM leads ORDER BY id LIMIT 50;

-- Next page — pass the last id from the previous page as the cursor:
SELECT id, name FROM leads WHERE id > ? ORDER BY id LIMIT 50;
```

Keyset pagination is O(log n) regardless of page number, stable across
inserts, and composes nicely with indexes. The only time OFFSET is OK is
tiny, one-shot lists where you know the table is small.
