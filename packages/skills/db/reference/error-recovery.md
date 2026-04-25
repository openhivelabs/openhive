# error-recovery

What the server does when your plan fails, and what that means for how
you write plans.

## Server guarantees

1. **Transaction per install.** All of your `alter_sql` + the frame's
   (non-skipped) setup.sql run in one SQLite transaction. Any failure →
   full rollback. The DB is never left half-migrated.
2. **Idempotency on ALTER.** "column already exists" errors are caught
   and treated as OK. Safe to replay an install.
3. **Fallback on AI failure.** If your JSON is malformed or the decision
   field is missing, the server treats it as `decision: standalone` and
   proceeds with the frame's setup.sql. User never sees a broken UI.
4. **Preview is side-effect-free.** Nothing touches the DB until the user
   clicks "Connect" or "Keep separate". If the user backs out, zero state
   changes.

## What you should do in response

- **Never worry about existence checks.** Just emit the ALTER. If the
  column already exists, server logs it and continues.
- **Never emit SELECT inside alter_sql.** That list is for DDL / ALTER
  only. Read-only inspection happens at preview time, before you're called.
- **Keep alter_sql order stable.** Server runs them in array order. If
  statement #3 depends on #1's new column existing, keep them in that order.

## Plans that WILL fail (don't emit)

- `ALTER TABLE x DROP COLUMN y` — SQLite doesn't support column drop in
  older versions. Unsafe.
- `ALTER TABLE x ADD COLUMN y TEXT NOT NULL` with no DEFAULT on a
  non-empty table — SQLite rejects.
- `CREATE UNIQUE INDEX` over non-unique existing data — will fail the
  transaction and the whole install rolls back.
- `PRAGMA foreign_keys = ON` inside a transaction — no-op at best, error
  at worst.

## What to do when you're unsure

Drop to `standalone` with confidence ≤ 0.6. The user will see the lower
confidence reflected in the UI (default button becomes "Keep separate").
They explicitly opt in or skip. Either outcome is safe.

## Retry policy

If the server retries your call (e.g., first JSON was malformed), you'll
see the same inputs again. Be deterministic — same inputs should produce
the same plan. Temperature 0 on the model side.
