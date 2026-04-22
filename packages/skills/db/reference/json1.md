# JSON1 in per-team SQLite

The JSON1 extension is compiled into every modern SQLite build and is always
available in `better-sqlite3`. This file covers the functions you actually
need when working against a per-team OpenHive DB.

## Confirming JSON1 is present

You almost never need to check this, but if a query fails mysteriously:

```sql
SELECT sqlite_version(), json_valid('{}');
-- expect something like: 3.45.1 | 1
```

If `json_valid` errors with "no such function", the build is broken — stop
and report. In practice this never fails inside OpenHive because
`better-sqlite3` bundles a recent amalgamation.

## Reading fields

The canonical form is `json_extract`:

```sql
SELECT id,
       json_extract(data, '$.priority')   AS priority,
       json_extract(data, '$.owner.name') AS owner_name
  FROM leads;
```

SQLite 3.38+ also supports the operator shorthands:

- `data -> '$.priority'` — returns a JSON value (still JSON text for strings,
  quoted).
- `data ->> '$.priority'` — returns a SQL scalar (TEXT / INTEGER / REAL /
  NULL), equivalent to `json_extract`.

Almost always use `->>` (or `json_extract`) in `WHERE` / `SELECT` lists. Use
`->` only when you want to keep a nested JSON fragment as JSON and hand it to
another JSON function.

## Writing fields

`json_set` replaces or inserts a value at a path:

```sql
UPDATE leads
   SET data = json_set(data, '$.priority', 'high'),
       updated_at = unixepoch()
 WHERE id = ?;
```

`json_insert` only writes if the path does not already exist; `json_replace`
only writes if it does. `json_set` is the safe default.

Patch multiple fields at once with `json_patch`:

```sql
UPDATE leads
   SET data = json_patch(data, '{"priority":"high","source":"referral"}'),
       updated_at = unixepoch()
 WHERE id = ?;
```

`json_patch` is RFC 7396 merge-patch — nested objects merge recursively, and
a `null` value removes the key. For arrays it replaces wholesale.

## Removing fields

```sql
UPDATE leads
   SET data = json_remove(data, '$.obsolete', '$.stale_flag'),
       updated_at = unixepoch()
 WHERE id = ?;
```

`json_remove` accepts multiple paths in one call. It is a no-op for paths
that don't exist, so it's safe to call defensively.

## Iterating arrays with `json_each`

`json_each` turns a JSON array (or object) into a virtual table you can join
against. Classic example — find leads that have a specific tag:

```sql
SELECT DISTINCT l.id, l.name
  FROM leads AS l,
       json_each(l.data, '$.tags') AS je
 WHERE je.value = ?;
```

`json_each(x)` iterates the top level; pass a path as the second arg to
iterate a sub-array. The virtual table exposes `key`, `value`, `type`, `atom`,
`fullkey`, and `path`.

For deep recursion use `json_tree` instead — it walks the whole document.

## Type coercion gotchas

`json_extract` (and `->>`) return SQLite scalar types that mirror the JSON
type: string → TEXT, number → INTEGER or REAL, boolean → INTEGER (0/1),
null → NULL. When you mix JSON values with real columns, cast explicitly:

```sql
SELECT id
  FROM leads
 WHERE CAST(json_extract(data, '$.score') AS REAL) > 0.8;
```

Without the `CAST`, a string like `"0.8"` and a number `0.8` compare
differently, and indexes built on a different expression won't match.

Also: `json_extract(data, '$.missing')` returns `NULL`, not a SQL error — use
`COALESCE` if you need a default.

## Common recipes

**Tag search** (most agents will need this at some point):

```sql
SELECT id
  FROM leads, json_each(leads.data, '$.tags') je
 WHERE je.value = ?;
```

**Increment a counter in JSON** (no `INCR`, so read-modify-write):

```sql
UPDATE leads
   SET data = json_set(
                data,
                '$.view_count',
                COALESCE(json_extract(data, '$.view_count'), 0) + 1
              )
 WHERE id = ?;
```

**Append to a JSON array**:

```sql
UPDATE leads
   SET data = json_set(
                data,
                '$.tags[#]',   -- '[#]' means "append"
                ?
              )
 WHERE id = ?;
```

For indexing these expressions, see [`indexes.md`](./indexes.md). For
decisions about when a field should leave `data` and become a real column,
see [`hybrid-schema.md`](./hybrid-schema.md).
