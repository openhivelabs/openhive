# fk-patterns

Standard shapes for cross-table references in OpenHive.

## Naming convention

- FK column name: `<ref_table>_id` (singular).
  - `customer.id` → `deal.customer_id`, `task.customer_id`, `note.customer_id`
  - `deal.id` → `task.deal_id`
- Type: match the referenced PK exactly. OpenHive PKs are `INTEGER PRIMARY
  KEY AUTOINCREMENT`, so FKs are `INTEGER`.
- Nullability: FKs default to NULL (row may or may not be linked).

## Adding an FK via ALTER

```sql
ALTER TABLE task ADD COLUMN customer_id INTEGER;
-- Optional index for lookup speed (propose as a follow-up if the table has >1k rows)
CREATE INDEX IF NOT EXISTS idx_task_customer ON task(customer_id);
```

SQLite doesn't enforce FK constraints on `ALTER TABLE ADD COLUMN` — the
column is just an INTEGER. That's fine. Enforcement lives at the app
layer (action INSERTs that auto-bind `:team_id` also validate ref rows
exist, if configured).

## Polymorphic references (avoid unless necessary)

Instead of `note.deal_id + note.task_id + note.contact_id`, prefer a
single `ref_table TEXT + ref_id INTEGER` pair:

```sql
CREATE TABLE note (
  team_id TEXT NOT NULL,
  id INTEGER PRIMARY KEY,
  body TEXT,
  ref_table TEXT,    -- 'deal' | 'task' | 'contact'
  ref_id INTEGER
);
```

Use this when one table needs to hang off many others. Downside: no SQL-
level FK, only a convention. Good for event / activity feeds. Avoid for
transactional primaries.

## Index hints (when to suggest)

- If `row_count > 500` on the target table → add an index on the FK column
- If the panel_sql has a JOIN on the FK → definitely index
- For small static-ish lookup tables (< 100 rows) → skip, full scan is fine

## Team scoping rule

FKs do NOT need `team_id` in their type or constraint — the `team_id =
:team_id` WHERE clause on every SELECT filters before the join:

```sql
SELECT d.title, c.name
  FROM deal d
  JOIN customer c ON c.id = d.customer_id
 WHERE d.team_id = :team_id AND c.team_id = :team_id
```

Both sides carry team_id and both are filtered. This keeps the soft
namespace tight even with cross-table reads.

## Schema migrations on FK add

When you emit `ALTER TABLE x ADD COLUMN y_id INTEGER`, the server logs
the ALTER in `schema_migrations` tagged with the installing team's id.
If the user later exports the team as a frame, that ALTER ships as part
of the frame's data_schema and re-applies on install elsewhere. So FKs
propagate.
