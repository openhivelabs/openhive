# db-skill reference bundle

Human-facing design notes. The engine **does not** auto-inject these files into
personas — they are loaded on demand via the `db_read_guide(topic)` tool.

Top-level guidance (workflow, hybrid-schema in one line, safety rails) lives in
the tool descriptions themselves (see `apps/web/lib/server/tools/team-data-tool.ts`).
These files exist for the deep-dive topics an agent may need mid-task.

## Topics

- `hybrid-schema.md` — when to add a column vs. use the `data` JSON field
- `json1.md` — `json_extract`, `json_set`, `json_each` recipes
- `indexes.md` — expression, partial, and covering indexes
- `patterns.md` — upsert, soft-delete, FTS5, time-series rollups
- `perf.md` — reading `EXPLAIN QUERY PLAN`, avoiding N+1

## Ownership

Any change to the tool surface (signatures, error codes, safety gates) must be
mirrored in the relevant reference file so agents get consistent guidance.
