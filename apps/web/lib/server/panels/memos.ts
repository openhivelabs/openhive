import type Database from 'better-sqlite3'
import { withCompanyDb } from '../team-data'

/** Multi-note memo storage. Each panel can hold any number of notes
 *  identified by `note_id`. The legacy single-blob shape is migrated on
 *  first read by adding the new columns idempotently — existing rows
 *  inherit the default `legacy-1` note id and sort_order 0. */
const DDL = `
CREATE TABLE IF NOT EXISTS panel_memos (
  team_id    TEXT NOT NULL,
  panel_id   TEXT NOT NULL,
  note_id    TEXT NOT NULL DEFAULT 'legacy-1',
  content    TEXT NOT NULL DEFAULT '',
  sort_order REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, panel_id, note_id)
)
`

function ensureSchema(db: Database.Database): void {
  db.exec(DDL)
  // Add the multi-note columns to legacy DBs that predate them. SQLite
  // has no IF NOT EXISTS for ADD COLUMN so we swallow the duplicate
  // errors and trust subsequent SELECTs to find the columns.
  for (const stmt of [
    "ALTER TABLE panel_memos ADD COLUMN note_id TEXT NOT NULL DEFAULT 'legacy-1'",
    'ALTER TABLE panel_memos ADD COLUMN sort_order REAL NOT NULL DEFAULT 0',
  ]) {
    try {
      db.exec(stmt)
    } catch {
      /* column already exists */
    }
  }
  // Old installs have a 2-column primary key (team_id, panel_id), which
  // makes inserting a second note for the same panel violate UNIQUE on
  // INSERT. Detect and rebuild the table with the new 3-col PK so
  // multiple notes per panel are allowed. Idempotent — no-op once the
  // table is on the new shape.
  type PragmaCol = { name: string; pk: number }
  const cols = db.prepare('PRAGMA table_info(panel_memos)').all() as PragmaCol[]
  const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name)
  const needsRebuild = !pkCols.includes('note_id')
  if (needsRebuild) {
    db.exec('BEGIN')
    try {
      db.exec('ALTER TABLE panel_memos RENAME TO panel_memos_old')
      db.exec(DDL)
      db.exec(
        `INSERT INTO panel_memos (team_id, panel_id, note_id, content, sort_order, updated_at)
         SELECT team_id, panel_id,
                COALESCE(NULLIF(note_id, ''), 'legacy-1'),
                content,
                COALESCE(sort_order, 0),
                updated_at
         FROM panel_memos_old`,
      )
      db.exec('DROP TABLE panel_memos_old')
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}

export interface MemoRow {
  note_id: string
  content: string
  sort_order: number
  updated_at: number
}

export function listMemos(
  companySlug: string,
  teamId: string,
  panelId: string,
): MemoRow[] {
  return withCompanyDb(companySlug, (db) => {
    ensureSchema(db)
    return db
      .prepare(
        'SELECT note_id, content, sort_order, updated_at FROM panel_memos ' +
          'WHERE team_id = ? AND panel_id = ? ORDER BY sort_order, updated_at',
      )
      .all(teamId, panelId) as MemoRow[]
  })
}

export function createMemo(
  companySlug: string,
  teamId: string,
  panelId: string,
  content = '',
): MemoRow {
  const now = Date.now()
  const noteId = `n-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
  return withCompanyDb(companySlug, (db) => {
    ensureSchema(db)
    const max = db
      .prepare(
        'SELECT COALESCE(MAX(sort_order), 0) AS m FROM panel_memos WHERE team_id = ? AND panel_id = ?',
      )
      .get(teamId, panelId) as { m: number }
    const sortOrder = (max.m ?? 0) + 1
    db.prepare(
      `INSERT INTO panel_memos (team_id, panel_id, note_id, content, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(teamId, panelId, noteId, content, sortOrder, now)
    return { note_id: noteId, content, sort_order: sortOrder, updated_at: now }
  })
}

export function updateMemo(
  companySlug: string,
  teamId: string,
  panelId: string,
  noteId: string,
  patch: { content?: string; sort_order?: number },
): MemoRow | null {
  const now = Date.now()
  return withCompanyDb(companySlug, (db) => {
    ensureSchema(db)
    const sets: string[] = []
    const vals: unknown[] = []
    if (typeof patch.content === 'string') {
      sets.push('content = ?')
      vals.push(patch.content)
    }
    if (typeof patch.sort_order === 'number') {
      sets.push('sort_order = ?')
      vals.push(patch.sort_order)
    }
    if (sets.length === 0) {
      return (db
        .prepare(
          'SELECT note_id, content, sort_order, updated_at FROM panel_memos ' +
            'WHERE team_id = ? AND panel_id = ? AND note_id = ?',
        )
        .get(teamId, panelId, noteId) as MemoRow | undefined) ?? null
    }
    sets.push('updated_at = ?')
    vals.push(now)
    vals.push(teamId, panelId, noteId)
    db.prepare(
      `UPDATE panel_memos SET ${sets.join(', ')} WHERE team_id = ? AND panel_id = ? AND note_id = ?`,
    ).run(...vals)
    return (db
      .prepare(
        'SELECT note_id, content, sort_order, updated_at FROM panel_memos ' +
          'WHERE team_id = ? AND panel_id = ? AND note_id = ?',
      )
      .get(teamId, panelId, noteId) as MemoRow | undefined) ?? null
  })
}

export function deleteMemo(
  companySlug: string,
  teamId: string,
  panelId: string,
  noteId: string,
): boolean {
  return withCompanyDb(companySlug, (db) => {
    ensureSchema(db)
    const info = db
      .prepare(
        'DELETE FROM panel_memos WHERE team_id = ? AND panel_id = ? AND note_id = ?',
      )
      .run(teamId, panelId, noteId)
    return info.changes > 0
  })
}
