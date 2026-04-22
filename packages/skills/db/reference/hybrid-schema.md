# Hybrid schema — columns vs. `data` JSON

OpenHive per-team databases use a **hybrid schema**: anything that needs to be
queried, indexed, constrained, or joined lives in a real column; everything
else — optional tags, extension metadata, turn-to-turn experimentation — goes
into a single `data TEXT NOT NULL DEFAULT '{}'` column holding JSON1.

This keeps the table narrow and fast on the hot path while still letting the
agent (or a later turn / different agent) add new fields without a migration
round-trip.

## Principle

- **Template columns** are for fields the product knows about up front:
  queryable, indexable, typed, possibly `NOT NULL`, sometimes FK targets.
- **`data` JSON** is the extensible tail. It absorbs fields you don't know
  about at design time, sparse attributes (most rows leave them `NULL`), and
  experimental flags an agent adds during a single task.
- Columns promise **performance + integrity**. `data` promises **flexibility**.
  Keep each side honest about what it's for.

## Decision table

Use this quick check when deciding where a new field belongs:

```
Filter/sort by it frequently?          → column
NOT NULL or typed (int, date)?         → column
Appears in FK relationships?           → column
One-off tag / user-added field?        → data JSON
Sparse (most rows NULL)?               → data JSON
Unknown at design time?                → data JSON (promote to column later)
```

If two or more rows point at "column", just add the column. Don't try to be
clever by stuffing a clearly-structured field into JSON — you'll pay for it in
every query.

## Starter skeleton every table should have

Every domain table should start from this shape:

```sql
CREATE TABLE leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  data       TEXT    NOT NULL DEFAULT '{}'   -- JSON1 extension field
  -- domain-specific columns go here, e.g.:
  -- name     TEXT    NOT NULL,
  -- status   TEXT    NOT NULL CHECK (status IN ('open','won','lost')),
  -- owner_id INTEGER REFERENCES users(id)
);
```

Notes on the skeleton:

- `unixepoch()` returns seconds since epoch as INTEGER — cheap to compare,
  easy to sort, and avoids timezone bugs. SQLite 3.38+ (shipped with modern
  `better-sqlite3`) has it built in.
- Keep `updated_at` maintained by your UPDATE statements or a trigger; SQLite
  has no `ON UPDATE CURRENT_TIMESTAMP` shorthand.
- `data` being `NOT NULL DEFAULT '{}'` means you can always `json_set()` into
  it without first checking for `NULL`.

## Working with the `data` column

Read a field:

```sql
SELECT id, json_extract(data, '$.priority') AS priority FROM leads;
```

Write a field without clobbering the rest of the object:

```sql
UPDATE leads
   SET data = json_set(data, '$.priority', 'high'),
       updated_at = unixepoch()
 WHERE id = ?;
```

Remove a field:

```sql
UPDATE leads
   SET data = json_remove(data, '$.obsolete_flag'),
       updated_at = unixepoch()
 WHERE id = ?;
```

For more JSON1 patterns (array iteration, type coercion, `json_patch`), see
[`json1.md`](./json1.md).

## Promotion rule

Once a `data.$.field` is queried in **more than three places** — or appears in
an `ORDER BY` / `WHERE` on a table that's grown past a few thousand rows —
promote it to a real column. The migration is always two steps:

```sql
-- Migration 1: add column, backfill from JSON
ALTER TABLE leads ADD COLUMN priority TEXT;
UPDATE leads SET priority = json_extract(data, '$.priority');
CREATE INDEX ix_leads_priority ON leads (priority);

-- Migration 2 (a later turn, after the app reads the new column):
UPDATE leads SET data = json_remove(data, '$.priority');
```

Split into two migrations so any in-flight code that still reads
`json_extract(data, '$.priority')` keeps working between deploys. Record both
migrations in `schema_migrations` — OpenHive's DDL path enforces this.

The reverse (demoting a column back into JSON) is rare; if a column turns out
to be unused, drop it outright rather than moving it to JSON.

## When NOT to use `data` JSON

- Fields that participate in a unique constraint — put them in columns.
- Foreign keys — SQLite can't enforce FKs on JSON-extracted values.
- Anything aggregated in reports every minute — indexing JSON is possible
  (see [`indexes.md`](./indexes.md)) but still slower than a plain column.
- Large blobs (base64 files, long transcripts). Use a separate table with a
  BLOB column or a file reference; JSON parsing on every row is expensive.

## Links

- JSON1 operator / function reference — [`json1.md`](./json1.md)
- Indexing JSON expressions — [`indexes.md`](./indexes.md)
- Concrete table-design recipes (upsert, soft-delete, FTS5) — [`patterns.md`](./patterns.md)
