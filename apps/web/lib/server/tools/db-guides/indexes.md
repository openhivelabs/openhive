# Indexes — plain, expression, partial, covering

SQLite's planner is good but not magic. Once a table is larger than ~1k rows
and a query gets repeated, you need indexes. This file covers the four index
shapes you'll reach for in a per-team OpenHive DB, and how to tell whether
the planner actually used one.

## Basic single-column index

The default and most common shape:

```sql
CREATE INDEX ix_leads_name ON leads (name);
```

Speeds up `WHERE name = ?`, `WHERE name LIKE 'Acme%'` (prefix only — leading
`%` disables the index), and `ORDER BY name`. Composite indexes work left-to-
right: an index on `(status, created_at)` helps `WHERE status = ?` and
`WHERE status = ? ORDER BY created_at`, but not `WHERE created_at > ?` alone.

## Expression index over JSON

Index the result of a `json_extract` call so filters on a `data.$.field` are
fast without promoting it to a column:

```sql
CREATE INDEX ix_leads_priority
  ON leads (json_extract(data, '$.priority'));
```

**Critical**: the `WHERE` clause must use the **exact same expression** for
the planner to pick up the index. This uses the index:

```sql
SELECT * FROM leads WHERE json_extract(data, '$.priority') = 'high';
```

This does **not** — the shorthand is a different expression as far as the
planner is concerned:

```sql
SELECT * FROM leads WHERE data ->> '$.priority' = 'high';  -- index unused
```

Pick one spelling and use it everywhere, or create the index with the same
spelling you query with. Verify with `db_explain` (see below).

## Partial index

Limit the index to the rows you actually query — smaller index, faster
writes, cheaper planner:

```sql
CREATE INDEX ix_open_leads
  ON leads (created_at)
  WHERE status = 'open';
```

This only indexes open leads, which is typically a small fraction of the
table. The planner uses it whenever the query `WHERE` clause implies the
partial predicate, e.g. `WHERE status = 'open' AND created_at > ?`.

Partial indexes are the right answer for soft-delete tables:

```sql
CREATE INDEX ix_leads_live ON leads (id) WHERE deleted_at IS NULL;
```

## Covering index

Include extra columns in the index so the planner can answer the query
without touching the main table at all (`USING COVERING INDEX` in the plan):

```sql
CREATE INDEX ix_leads_name_status ON leads (name, status);

-- This query is answered entirely from the index:
SELECT name, status FROM leads WHERE name = ?;
```

If your `SELECT` list only contains indexed columns (plus `rowid`/primary
key), SQLite doesn't need the table at all. For very hot read paths this can
be 2–5× faster than a normal index lookup.

Don't go overboard: every column in a covering index makes writes slower and
the index bigger on disk.

## When to add an index

- Run the query through `db_explain` first. If you see `SCAN TABLE x` and the
  table has more than ~1k rows, that's the signal.
- Index the column(s) in the `WHERE`, then any column in `ORDER BY`, then
  consider covering if the `SELECT` list is narrow.
- Re-run `db_explain`. Look for `SEARCH TABLE x USING INDEX ix_…` — success.
  `USING COVERING INDEX` — even better. Still `SCAN` — the expression
  doesn't match, fix it.

See [`perf.md`](./perf.md) for reading `EXPLAIN QUERY PLAN` output in depth.

## Cost of indexes

Every index is maintained on every `INSERT` / `UPDATE` / `DELETE` that
touches its columns. Rules of thumb:

- Don't index low-cardinality boolean-ish columns (`is_active`, `status` with
  two values) **unless** you pair it with a partial predicate — otherwise the
  index doesn't narrow the search enough to be worth the write cost.
- Don't pre-emptively index "just in case". Add indexes when a query is
  demonstrably slow; drop them if they go unused.
- Composite > multiple single-column for AND-heavy queries. SQLite rarely
  intersects two indexes.
- After a large data-shape change (bulk import, big delete), run
  `ANALYZE;` to refresh the planner's statistics.

## Verifying

```sql
EXPLAIN QUERY PLAN
SELECT * FROM leads WHERE json_extract(data, '$.priority') = 'high';
```

Or use `db_explain` — it returns the plan as JSON and flags common issues
("full table scan", "temp b-tree for ORDER BY").
