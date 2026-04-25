# table-check

How the existing-schema payload is structured, and how to parse it.

## Input shape

The server sends existing schema as an array:

```json
[
  {
    "name": "customer",
    "columns": [
      { "name": "team_id", "type": "TEXT", "notnull": true, "pk": false },
      { "name": "id", "type": "INTEGER", "notnull": true, "pk": true },
      { "name": "name", "type": "TEXT", "notnull": false, "pk": false },
      { "name": "email", "type": "TEXT", "notnull": false, "pk": false }
    ],
    "row_count": 42,
    "sample_row": { "id": 1, "name": "Alice", "email": "alice@x.com" }
  },
  ...
]
```

`row_count` lets you gauge whether the table is actively used (0 rows →
safer to reuse, no data to confuse) or heavily populated (reuse is higher
stakes, column additions need defaults).

## Reading the incoming frame

```json
{
  "setup_sql": "CREATE TABLE IF NOT EXISTS customer (...)",
  "panel_sql": "SELECT ... FROM customer WHERE team_id = :team_id"
}
```

Parse `setup_sql` for each CREATE TABLE: pull out the table name and
columns. Parse `panel_sql` for:
- Table names in FROM / JOIN clauses (what the panel actually reads)
- Column names in SELECT (what must exist on the target table)

If the panel reads a column that doesn't exist on your proposed `target_table`,
your decision is wrong — adjust.

## Signals for each decision

**Strong `reuse` signals:**
- Table name exact match
- ≥80% of incoming columns present on existing (by name + type)
- No PK type clash

**Strong `extend` signals:**
- Table name exact match, but incoming adds 1–3 new columns
- Or: incoming creates new table with FK-shaped column (`<existing>_id`)
  pointing at existing

**Strong `standalone` signals:**
- No table name match AND no column-name overlap
- Zero existing tables (empty DB)
- Existing table has incompatible PK type or different semantic domain

## Anti-patterns (don't do this)

- Don't assume a `users` table is a `customer` table because "people". The
  user picked `users` for a reason; that's their system.
- Don't propose ALTER that changes an existing column's type — SQLite
  doesn't support it cleanly and you'd lose data.
- Don't merge a `task` and `ticket` table just because both have `status` —
  they're different entities.
- Don't invent new columns the incoming frame didn't ask for (no gold-plating).
