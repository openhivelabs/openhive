import { withCompanyDb } from '../team-data'

const DDL = `
CREATE TABLE IF NOT EXISTS panel_memos (
  team_id    TEXT NOT NULL,
  panel_id   TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, panel_id)
)
`

export interface MemoRow {
  content: string
  updated_at: number | null
}

export function getMemo(companySlug: string, teamId: string, panelId: string): MemoRow {
  return withCompanyDb(companySlug, (db) => {
    db.exec(DDL)
    const row = db
      .prepare(
        'SELECT content, updated_at FROM panel_memos WHERE team_id = ? AND panel_id = ?',
      )
      .get(teamId, panelId) as { content: string; updated_at: number } | undefined
    if (!row) return { content: '', updated_at: null }
    return { content: row.content, updated_at: row.updated_at }
  })
}

export function setMemo(
  companySlug: string,
  teamId: string,
  panelId: string,
  content: string,
): MemoRow {
  const now = Date.now()
  return withCompanyDb(companySlug, (db) => {
    db.exec(DDL)
    db.prepare(
      `INSERT INTO panel_memos (team_id, panel_id, content, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(team_id, panel_id) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`,
    ).run(teamId, panelId, content, now)
    return { content, updated_at: now }
  })
}
