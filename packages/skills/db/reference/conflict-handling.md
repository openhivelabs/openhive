# conflict-handling

Playbook for the three collision shapes you'll hit.

## 1. Column name collision, compatible type

Existing: `customer.stage TEXT`
Incoming: `customer.stage TEXT DEFAULT 'new'`

→ **reuse**. Existing column wins. The panel's SELECT still reads `stage`
successfully. Do NOT add a second column, do NOT change the default.

## 2. Column name collision, incompatible type

Existing: `customer.value TEXT`
Incoming: `customer.value REAL`

→ **standalone** with confidence ≤ 0.7. SQLite is loose but `SUM(value)`
over mixed types is unreliable. Brief to the user: "The existing customer
value type is incompatible, so this will be installed as a separate table."

If the user really wants to merge, they'll say "Keep separate" then
manually ALTER later. Your job is not to clobber their data.

## 3. Table name collision, totally different schemas

Existing: `event` (calendar events: title, start_at, location)
Incoming: `event` (audit log: actor, action, target, ts)

→ **standalone**. You can't merge two different entities that happened
to pick the same name. Brief should hint: "The existing event table stores
calendar events. This can be installed under a separate name, but for now it
will be installed as-is."

If the server's CREATE IF NOT EXISTS silently no-ops (SQLite ignores
redefinition), the panel will try to SELECT columns that don't exist and
fail at query time. To handle cleanly, set `decision: standalone` **and**
add a rename hint to `alter_sql`:
```
["-- SUGGEST: rename this frame's `event` to `audit_event` before re-install"]
```
SQL comments are no-ops but surface in the migration log.

Actually simpler: return `standalone` with `confidence: 0.4` and a brief
that tells the user about the conflict. They'll click "Keep separate" or
cancel.

## FK column name conflicts

If you propose `ALTER TABLE task ADD COLUMN customer_id INTEGER` and the
table already has `customer_id`, SQLite errors. The server catches that
and treats it as "column already there, carry on". Your plan doesn't
need to check first — fire-and-forget is fine.

## Team_id column

Every user table must carry `team_id TEXT NOT NULL`. If the incoming
frame's setup.sql forgot it:

```json
{
  "decision": "standalone",
  "alter_sql": [],
  "skip_create_tables": [],
  "rewrite_panel_sql": null,
  "confidence": 0.9,
  "_note_to_server": "setup.sql missing team_id — server should inject it"
}
```

Actually: just include a corrected CREATE in `alter_sql` (as the first
statement) and add the table to `skip_create_tables`:

```json
{
  "alter_sql": [
    "CREATE TABLE IF NOT EXISTS <table> (team_id TEXT NOT NULL, <original cols>)"
  ],
  "skip_create_tables": ["<table>"]
}
```

This is a rare case — all first-party seed panels have team_id. Mostly
you're catching third-party frames with sloppy YAML.
