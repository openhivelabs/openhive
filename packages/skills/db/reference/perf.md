# Performance — reading plans, fixing slow queries

Most "slow query" problems in a per-team DB come down to four things: a full
table scan that should be an index seek, a sort the planner had to
materialize, a correlated subquery running per row, or N+1 round trips from
the app. This file walks through each.

## Reading `EXPLAIN QUERY PLAN`

Prefix any query with `EXPLAIN QUERY PLAN` (or call `db_explain`) to see
what the planner will do:

```sql
EXPLAIN QUERY PLAN
SELECT * FROM leads WHERE status = 'open' ORDER BY created_at DESC LIMIT 20;
```

Typical output lines and what they mean:

- `SCAN TABLE leads` — full table scan, every row read. Fine for tiny
  tables; a red flag above a few thousand rows on a hot query.
- `SEARCH TABLE leads USING INDEX ix_leads_status (status=?)` — planner
  seeks into the index. Good.
- `SEARCH TABLE leads USING COVERING INDEX ix_leads_name_status` — even
  better: the index alone answers the query, no row fetch.
- `USE TEMP B-TREE FOR ORDER BY` — the planner materialized a sort because
  no index matched the `ORDER BY`. Add a matching index to remove it.
- `CORRELATED SCALAR SUBQUERY` — a subquery that runs once per outer row.
  Almost always worth rewriting as a JOIN.
- `SEARCH TABLE x USING AUTOMATIC COVERING INDEX` — SQLite built a throwaway
  index on the fly because the query was expensive enough to pay for it.
  Make the index permanent.

## Common fixes

**Fix 1: `SCAN` on a filtered column.** Add an index on the filter column.
If the filter is on a JSON field, use an expression index with the exact
same expression (see [`indexes.md`](./indexes.md)).

```sql
-- Before: SCAN TABLE leads
SELECT * FROM leads WHERE owner_id = ?;

-- After adding:
CREATE INDEX ix_leads_owner ON leads (owner_id);
-- Plan becomes: SEARCH TABLE leads USING INDEX ix_leads_owner (owner_id=?)
```

**Fix 2: `USE TEMP B-TREE FOR ORDER BY`.** Build an index that matches the
`ORDER BY`, including the filter prefix:

```sql
-- Query:
SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT 20;

-- Index that removes the temp b-tree:
CREATE INDEX ix_leads_status_created ON leads (status, created_at DESC);
```

SQLite can walk an index in either direction regardless of declared order,
but adding `DESC` can still matter for multi-column composite cases.

**Fix 3: Correlated subquery running per row.** Rewrite as a JOIN or use a
window function:

```sql
-- Slow: correlated subquery
SELECT l.*, (SELECT COUNT(*) FROM tasks t WHERE t.lead_id = l.id) AS n_tasks
  FROM leads l;

-- Faster: single aggregation JOIN
SELECT l.*, COALESCE(c.n_tasks, 0) AS n_tasks
  FROM leads l
  LEFT JOIN (SELECT lead_id, COUNT(*) AS n_tasks
               FROM tasks GROUP BY lead_id) c
    ON c.lead_id = l.id;
```

## N+1 queries

Symptom: a loop in the app firing `db_query` with `WHERE id = ?` once per
row. Even at 0.5 ms each, 200 rows = 100 ms of pure overhead. Collapse into
one call:

```sql
-- Instead of 200 calls of: SELECT * FROM leads WHERE id = ?
SELECT * FROM leads WHERE id IN (?, ?, ?, ?, ?, ...);   -- up to ~500 params
```

Or, if you're joining two tables in a loop, write the JOIN:

```sql
SELECT l.*, o.name AS owner_name
  FROM leads l
  LEFT JOIN users o ON o.id = l.owner_id
 WHERE l.status = 'open';
```

`db_query` emits `elapsed_ms`; if you see one fast query repeated dozens of
times, that's the smell.

## Batch writes

Every transaction has a non-trivial fsync cost. If you have many rows to
insert, either wrap them in one transaction or — better — use one
multi-row `INSERT`:

```sql
-- One statement, one fsync:
INSERT INTO leads (name, status) VALUES
  (?, ?),
  (?, ?),
  (?, ?);
-- up to SQLite's 500-row / 32k-parameter limit per statement
```

The `db_exec` tool wraps a single statement in a transaction for you; for
many rows either call it once with a multi-row `VALUES` list or (if the
driver is available) use a `BEGIN` / `COMMIT` pair around prepared-statement
reuse.

## `ANALYZE`

Planner statistics power most of its decisions. They're updated
automatically on schema changes but not on bulk data changes. After a big
import, mass-delete, or migration:

```sql
ANALYZE;
```

It's cheap (seconds on a typical team DB) and can change the plan for the
better overnight. If a query's plan looks wrong even with the right indexes
in place, `ANALYZE` is usually the cure.

## When to stop tuning

A per-team DB is single-user, local, and small. If the query is < 5 ms and
runs < 10×/second, stop — you're done. Spend the budget on the next
feature, not on squeezing microseconds.
