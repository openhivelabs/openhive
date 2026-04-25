/**
 * One-shot migration: merge per-team `data.db` files into a single
 * company-scoped `data.db` with a `team_id` soft namespace column on every
 * user table.
 *
 * Behavior:
 *   - Idempotent. A company whose `companies/<c>/data.db` already exists is
 *     skipped on the assumption it has been merged before.
 *   - Original team DBs are renamed `data.db.premigration-<ts>` (not
 *     deleted) so a human can roll back if anything looks off.
 *   - Safe to run at server boot; zero-work no-op when nothing to merge.
 *
 * Invoke via:
 *   - direct: `tsx apps/web/scripts/migrate-team-db-to-company.ts`
 *   - boot hook in apps/web/server/index.ts (see `runBootMigrations`)
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { listCompanies } from '@/lib/server/companies'
import { companiesRoot, companyDataDbPath, teamDataDbPath } from '@/lib/server/paths'

interface MigrationReport {
  company: string
  status: 'merged' | 'skipped' | 'error'
  teamsMerged?: string[]
  tablesCreated?: string[]
  rowsCopied?: number
  detail?: string
}

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  sql         TEXT NOT NULL,
  note        TEXT,
  team_id     TEXT
);
`

/** Extract CREATE TABLE SQL for a given table from sqlite_master. Returns
 *  the raw DDL so we can mutate it (insert the team_id column) before
 *  re-applying against the company DB. */
function getCreateSql(
  conn: BetterSqliteDatabase,
  table: string,
): string | null {
  const row = conn
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE type='table' AND name=? LIMIT 1`,
    )
    .get(table) as { sql: string | null } | undefined
  return row?.sql ?? null
}

/** Insert `team_id TEXT NOT NULL DEFAULT '<default>'` as the first column in
 *  a CREATE TABLE statement. Handles the common shape
 *    CREATE TABLE name (col1 …, col2 …, …)
 *  — whitespace tolerant. If parsing fails, returns null so the caller falls
 *  back to an ALTER TABLE ADD COLUMN after CREATE. */
function addTeamIdColumn(createSql: string, defaultTeamId: string): string | null {
  const match = createSql.match(/^(CREATE\s+TABLE[^(]+\()([\s\S]+)\)(\s*)$/i)
  if (!match) return null
  const head = match[1]!
  const body = match[2]!
  const tail = match[3]!
  const esc = defaultTeamId.replace(/'/g, "''")
  const newBody = `team_id TEXT NOT NULL DEFAULT '${esc}',\n  ${body}`
  return `${head}${newBody})${tail}`
}

function listUserTables(conn: BetterSqliteDatabase): string[] {
  return (
    conn
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name NOT LIKE 'sqlite_%'
            AND name <> 'schema_migrations'
          ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
}

function mergeTeamIntoCompany(
  company: BetterSqliteDatabase,
  teamDbFile: string,
  teamId: string,
): { tablesCreated: string[]; rowsCopied: number } {
  const team = new Database(teamDbFile, { readonly: true })
  const tablesCreated: string[] = []
  let rowsCopied = 0
  try {
    const tables = listUserTables(team)
    for (const tableName of tables) {
      const createSql = getCreateSql(team, tableName)
      if (!createSql) continue
      // Ensure table exists on company side. If absent, create with team_id
      // prepended as the first column.
      const exists = company
        .prepare(
          `SELECT 1 FROM sqlite_master
            WHERE type='table' AND name=? LIMIT 1`,
        )
        .get(tableName)
      if (!exists) {
        const rewritten = addTeamIdColumn(createSql, teamId)
        if (rewritten) {
          company.exec(rewritten)
        } else {
          // Fallback: run original CREATE, then ALTER ADD COLUMN.
          company.exec(createSql)
          try {
            company.exec(
              `ALTER TABLE ${tableName} ADD COLUMN team_id TEXT NOT NULL DEFAULT '${teamId.replace(/'/g, "''")}'`,
            )
          } catch {
            /* column may already exist on re-run */
          }
        }
        tablesCreated.push(tableName)
      } else {
        // Ensure team_id column present on already-created tables (earlier
        // partial migration could have made a table without it).
        const cols = company
          .prepare(`PRAGMA table_info(${tableName})`)
          .all() as { name: string }[]
        if (!cols.some((c) => c.name === 'team_id')) {
          try {
            company.exec(
              `ALTER TABLE ${tableName} ADD COLUMN team_id TEXT NOT NULL DEFAULT '${teamId.replace(/'/g, "''")}'`,
            )
          } catch {
            /* ignore */
          }
        }
      }

      // Copy rows with team_id set. SQLite ATTACH would be slightly faster
      // but requires both DBs on the same connection and the WAL state
      // between them is finicky — iterate in JS instead.
      const srcCols = (
        team
          .prepare(`PRAGMA table_info(${tableName})`)
          .all() as { name: string }[]
      ).map((c) => c.name)
      if (srcCols.length === 0) continue
      const srcRows = team
        .prepare(`SELECT * FROM ${tableName}`)
        .all() as Record<string, unknown>[]
      if (srcRows.length === 0) continue
      const allCols = ['team_id', ...srcCols.filter((c) => c !== 'team_id')]
      const placeholders = allCols.map(() => '?').join(', ')
      const insert = company.prepare(
        `INSERT INTO ${tableName} (${allCols.join(', ')}) VALUES (${placeholders})`,
      )
      const tx = company.transaction(() => {
        for (const row of srcRows) {
          const values = allCols.map((c) =>
            c === 'team_id' ? teamId : (row[c] as unknown),
          )
          insert.run(...(values as unknown[]))
        }
      })
      tx()
      rowsCopied += srcRows.length
    }

    // Merge schema_migrations (tagged with team_id).
    const hasTable = team
      .prepare(
        `SELECT 1 FROM sqlite_master
          WHERE type='table' AND name='schema_migrations' LIMIT 1`,
      )
      .get()
    if (hasTable) {
      const rows = team
        .prepare(
          `SELECT applied_at, source, sql, note
             FROM schema_migrations
             ORDER BY id ASC`,
        )
        .all() as {
        applied_at: number
        source: string
        sql: string
        note: string | null
      }[]
      const insert = company.prepare(
        `INSERT INTO schema_migrations (applied_at, source, sql, note, team_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      const tx = company.transaction(() => {
        for (const r of rows) {
          insert.run(r.applied_at, r.source, r.sql, r.note, teamId)
        }
      })
      tx()
    }
  } finally {
    team.close()
  }
  return { tablesCreated, rowsCopied }
}

function migrateOneCompany(companySlug: string, companyDir: string): MigrationReport {
  const companyFile = companyDataDbPath(companySlug)
  if (fs.existsSync(companyFile)) {
    return { company: companySlug, status: 'skipped', detail: 'already migrated' }
  }
  const teamsDir = path.join(companyDir, 'teams')
  if (!fs.existsSync(teamsDir) || !fs.statSync(teamsDir).isDirectory()) {
    return { company: companySlug, status: 'skipped', detail: 'no teams dir' }
  }

  const entries = fs.readdirSync(teamsDir, { withFileTypes: true })
  const teamWork: { slug: string; id: string; dbFile: string }[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const teamSlug = e.name
    const teamDb = teamDataDbPath(companySlug, teamSlug)
    if (!fs.existsSync(teamDb)) continue
    // Resolve team_id from the team yaml next to the dir (companies/<c>/teams/<slug>.yaml).
    const yamlFile = path.join(teamsDir, `${teamSlug}.yaml`)
    let teamId = teamSlug
    if (fs.existsSync(yamlFile)) {
      try {
        const yaml = require('js-yaml') as typeof import('js-yaml')
        const parsed = yaml.load(fs.readFileSync(yamlFile, 'utf8')) as {
          id?: unknown
        } | null
        if (parsed && typeof parsed.id === 'string' && parsed.id) {
          teamId = parsed.id
        }
      } catch {
        /* fall back to slug */
      }
    }
    teamWork.push({ slug: teamSlug, id: teamId, dbFile: teamDb })
  }

  if (teamWork.length === 0) {
    return { company: companySlug, status: 'skipped', detail: 'no team data.db files' }
  }

  fs.mkdirSync(path.dirname(companyFile), { recursive: true })
  const company = new Database(companyFile)
  company.pragma('journal_mode = WAL')
  company.pragma('foreign_keys = ON')
  company.exec(BOOTSTRAP)

  const tablesCreated = new Set<string>()
  let rowsCopied = 0
  const teamsMerged: string[] = []
  try {
    for (const t of teamWork) {
      const res = mergeTeamIntoCompany(company, t.dbFile, t.id)
      for (const x of res.tablesCreated) tablesCreated.add(x)
      rowsCopied += res.rowsCopied
      teamsMerged.push(t.slug)
    }
  } finally {
    company.close()
  }

  // Rename old per-team DBs so they don't get re-merged on subsequent boots
  // and the user can roll back manually if something looks off.
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
  for (const t of teamWork) {
    try {
      fs.renameSync(t.dbFile, `${t.dbFile}.premigration-${stamp}`)
    } catch {
      /* ignore — another run may have renamed it */
    }
  }

  return {
    company: companySlug,
    status: 'merged',
    teamsMerged,
    tablesCreated: [...tablesCreated].sort(),
    rowsCopied,
  }
}

/** Public entrypoint. Runs across every company discovered under
 *  `companies/`. Logs each outcome. Never throws — returns the report so a
 *  caller (or boot hook) can decide what to do with partial failures. */
export function migrateTeamDbsToCompany(): MigrationReport[] {
  const root = companiesRoot()
  if (!fs.existsSync(root)) return []
  const reports: MigrationReport[] = []
  const companies = listCompanies()
  for (const c of companies) {
    const slug = c.slug ?? ''
    if (!slug) continue
    const dir = path.join(root, slug)
    try {
      const r = migrateOneCompany(slug, dir)
      reports.push(r)
    } catch (err) {
      reports.push({
        company: slug,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }
  for (const r of reports) {
    if (r.status === 'merged') {
      console.log(
        `[migrate:team→company] ${r.company}: merged ${r.teamsMerged?.length ?? 0} team(s), ` +
          `${r.tablesCreated?.length ?? 0} table(s), ${r.rowsCopied ?? 0} row(s)`,
      )
    } else if (r.status === 'error') {
      console.error(`[migrate:team→company] ${r.company}: ERROR — ${r.detail}`)
    }
    // skipped status is silent — normal on repeat boots.
  }
  return reports
}

// CLI: `tsx apps/web/scripts/migrate-team-db-to-company.ts`
if (require.main === module) {
  const reports = migrateTeamDbsToCompany()
  const merged = reports.filter((r) => r.status === 'merged').length
  const errors = reports.filter((r) => r.status === 'error').length
  console.log(
    `done — ${merged} merged, ${errors} error(s), ${reports.length - merged - errors} skipped`,
  )
  process.exit(errors > 0 ? 1 : 0)
}
