# install-routing

Worked examples of the three install decisions. Read these when a case feels
close to the line.

## Example A — `reuse`

Existing:
```sql
CREATE TABLE customer (
  team_id TEXT NOT NULL,
  id INTEGER PRIMARY KEY,
  name TEXT, email TEXT, stage TEXT, value REAL
);
```

Incoming setup.sql:
```sql
CREATE TABLE IF NOT EXISTS customer (
  team_id TEXT NOT NULL,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, email TEXT
);
```

Output:
```json
{
  "decision": "reuse",
  "brief": "기존 customer 테이블을 그대로 사용합니다.",
  "target_table": "customer",
  "alter_sql": [],
  "skip_create_tables": ["customer"],
  "rewrite_panel_sql": null,
  "confidence": 0.95
}
```

Why: column overlap is total on incoming's side. Existing table has extra
columns (stage, value) which don't hurt; the panel only SELECTs what it needs.

## Example B — `extend` (new table with FK to existing)

Existing: `customer(team_id, id, name, email, stage)`

Incoming setup.sql creates `deal(team_id, id, title, amount, customer_id)`.

Output:
```json
{
  "decision": "standalone",
  "brief": "deal 테이블을 새로 만들고 customer.id를 참조합니다.",
  "target_table": "customer",
  "alter_sql": [],
  "skip_create_tables": [],
  "rewrite_panel_sql": null,
  "confidence": 0.9
}
```

Wait — this is `standalone` with a "references" note in the brief. The
incoming frame **already** has customer_id in its setup.sql, so no ALTER
needed. Just run setup.sql. Brief tells the user there's a logical link.

Use `extend` only when you must add columns **to an existing table** to
wire the relationship.

## Example C — `extend` (add FK to existing table)

Existing: `task(team_id, id, title, status)` — was installed alone.

Incoming setup.sql creates `task` (same table) again, but also wants to
link to `customer` that the user added later.

Output:
```json
{
  "decision": "extend",
  "brief": "기존 task에 customer_id 컬럼을 추가해 연결합니다.",
  "target_table": "task",
  "alter_sql": [
    "ALTER TABLE task ADD COLUMN customer_id INTEGER"
  ],
  "skip_create_tables": ["task"],
  "rewrite_panel_sql": null,
  "confidence": 0.75
}
```

Why: `task` already exists, so skip the CREATE; but add the new relation
column via ALTER. `skip_create_tables` tells the server to omit the frame's
CREATE for `task`.

## Example D — `standalone` (unrelated domains)

Existing: `player(team_id, id, name, position, jersey)` (a baseball roster)

Incoming setup.sql creates `invoice(team_id, id, customer_id, amount)`.

Output:
```json
{
  "decision": "standalone",
  "brief": "기존 데이터와 무관한 새 invoice 테이블을 만듭니다.",
  "target_table": null,
  "alter_sql": [],
  "skip_create_tables": [],
  "rewrite_panel_sql": null,
  "confidence": 0.95
}
```

Why: `player` and `invoice` share no semantics. `customer_id` on invoice
has no counterpart in existing schema. Standalone is honest.

## Example E — ambiguous (low confidence)

Existing: `contact(team_id, id, name, email)`

Incoming wants: `customer(team_id, id, name, email, stage)`.

Output:
```json
{
  "decision": "reuse",
  "brief": "기존 contact 테이블을 customer로 사용할 수 있습니다.",
  "target_table": "contact",
  "alter_sql": [
    "ALTER TABLE contact ADD COLUMN stage TEXT"
  ],
  "skip_create_tables": ["customer"],
  "rewrite_panel_sql": "SELECT COUNT(*) AS n FROM contact WHERE team_id = :team_id",
  "confidence": 0.55
}
```

Confidence 0.55 because the user might intentionally want `customer` and
`contact` to be different things. Server will show "Keep separate" as
default; user clicks "Connect" to opt in.

## Empty DB shortcut

If the existing schema has no user tables, **always** return `standalone`
with confidence 1.0. Don't waste tokens analyzing.
