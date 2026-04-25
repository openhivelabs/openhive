/**
 * Dev seed for panel iteration. Pumps representative rows into the local
 * hive's `data.db` so newly-installed panels have something to render.
 *
 * Picks the first company under ~/.openhive (or $OPENHIVE_HOME), seeds the
 * `main` team if it exists, otherwise the first team yaml found. Re-running
 * is safe: rows for the chosen team_id are wiped first, then re-inserted.
 *
 * Usage:
 *   pnpm dev:seed                      # seed first company / main team
 *   pnpm dev:seed -- --company X --team Y
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

interface Args {
  company?: string
  team?: string
}

function parseArgs(): Args {
  const out: Args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--company') out.company = argv[++i]
    else if (a === '--team') out.team = argv[++i]
  }
  return out
}

function hiveRoot(): string {
  return process.env.OPENHIVE_HOME ?? path.join(os.homedir(), '.openhive')
}

function pickCompany(prefer?: string): string {
  const root = path.join(hiveRoot(), 'companies')
  const all = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  if (all.length === 0) throw new Error(`no companies under ${root}`)
  if (prefer && all.includes(prefer)) return prefer
  return all[0]!
}

function pickTeam(companySlug: string, prefer?: string): { id: string; slug: string } {
  const teamsDir = path.join(hiveRoot(), 'companies', companySlug, 'teams')
  const yamls = fs
    .readdirSync(teamsDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
  if (yamls.length === 0) throw new Error(`no teams under ${teamsDir}`)
  const slug = prefer && yamls.includes(prefer) ? prefer : yamls.includes('main') ? 'main' : yamls[0]!
  const teamYaml = yaml.load(
    fs.readFileSync(path.join(teamsDir, `${slug}.yaml`), 'utf8'),
  ) as { id?: string }
  if (!teamYaml?.id) throw new Error(`team yaml missing id: ${slug}`)
  return { id: teamYaml.id, slug }
}

const STAGES = ['prospect', 'qualified', 'proposal', 'won', 'lost'] as const
const FIRST_NAMES = [
  'Aria', 'Ben', 'Cleo', 'Dax', 'Eli', 'Fia', 'Gus', 'Hana', 'Ivo', 'June',
  'Kai', 'Lee', 'Mia', 'Nox', 'Owen', 'Pia', 'Quin', 'Rae', 'Sol', 'Tess',
]
const LAST_NAMES = [
  'Park', 'Kim', 'Lee', 'Choi', 'Yun', 'Jang', 'Han', 'Oh', 'Min', 'Seo',
]

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function seedCustomer(db: Database.Database, teamId: string) {
  db.prepare('DELETE FROM customer WHERE team_id = ?').run(teamId)
  const rand = rng(0xC057E)
  const insert = db.prepare(
    'INSERT INTO customer (team_id, name, email, stage, value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const tx = db.transaction(() => {
    // 80 rows over the last 30 days, weighted later (so the trend curves up).
    for (let i = 0; i < 80; i += 1) {
      const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)]!
      const last = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)]!
      const name = `${first} ${last}`
      const email = `${first.toLowerCase()}.${last.toLowerCase()}@example.com`
      const stage = STAGES[Math.floor(rand() * STAGES.length)]!
      const value = Math.round(rand() * 50_000) / 100  // 0–500
      const dayOffset = Math.floor(Math.pow(rand(), 2) * 30)  // skew toward recent
      const ts = new Date(Date.now() - dayOffset * 86_400_000)
      ts.setHours(Math.floor(rand() * 24), Math.floor(rand() * 60))
      insert.run(teamId, name, email, stage, value, ts.toISOString().replace('T', ' ').slice(0, 19))
    }
  })
  tx()
}

function ensureCustomerTable(db: Database.Database) {
  // Mirrors the DDL the panel install path uses, so the script works even on
  // a hive where no panel has been installed yet.
  db.exec(`CREATE TABLE IF NOT EXISTS customer (
    team_id    TEXT NOT NULL,
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    email      TEXT,
    stage      TEXT DEFAULT 'prospect',
    value      REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
}

// ─── track table — for bar/column/pie chart category-distribution tests ──
// Skewed genre distribution (rock dominant, kpop niche). Picked so
// horizontal bar grows tall enough to show vertical scrolling, column chart
// grows wide enough to show horizontal scrolling, and pie has obvious slices.

function ensureTrackTable(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS track (
    team_id    TEXT NOT NULL,
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    artist     TEXT,
    genre      TEXT,
    length_sec INTEGER DEFAULT 0,
    plays      INTEGER DEFAULT 0,
    released_at TEXT
  )`)
}

const GENRE_WEIGHTS: { genre: string; weight: number }[] = [
  { genre: 'rock', weight: 22 },
  { genre: 'pop', weight: 18 },
  { genre: 'hiphop', weight: 14 },
  { genre: 'electronic', weight: 12 },
  { genre: 'jazz', weight: 9 },
  { genre: 'rnb', weight: 8 },
  { genre: 'classical', weight: 6 },
  { genre: 'metal', weight: 5 },
  { genre: 'country', weight: 4 },
  { genre: 'kpop', weight: 3 },
  { genre: 'folk', weight: 2 },
  { genre: 'ambient', weight: 1 },
]
const ARTISTS = [
  'Nova Static', 'Hana Kim', 'The Quiet Loop', 'Volt Orchard',
  'Mira Park', 'Echo Park Choir', 'Lake Zen', 'Bear Hours',
  'Pixel Drums', 'Vermilion Coast', 'Zinc Garden', 'Neon Mountain',
]
const TITLE_WORDS_A = ['Glass', 'Pale', 'Velvet', 'Iron', 'Quiet', 'Sapphire', 'Salt', 'Tin', 'Ember', 'Wild', 'Cosmic', 'Hollow']
const TITLE_WORDS_B = ['Drift', 'Garden', 'Vector', 'Hours', 'Field', 'Bloom', 'Mirror', 'Window', 'Static', 'Pulse', 'Lantern', 'Echo']

function pickWeighted<T>(rand: () => number, items: { v: T; weight: number }[]): T {
  const total = items.reduce((s, it) => s + it.weight, 0)
  let r = rand() * total
  for (const it of items) {
    r -= it.weight
    if (r <= 0) return it.v
  }
  return items[items.length - 1]!.v
}

function seedTrack(db: Database.Database, teamId: string) {
  db.prepare('DELETE FROM track WHERE team_id = ?').run(teamId)
  const rand = rng(0xBEAD)
  const insert = db.prepare(
    'INSERT INTO track (team_id, title, artist, genre, length_sec, plays, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const genreItems = GENRE_WEIGHTS.map((g) => ({ v: g.genre, weight: g.weight }))
  const tx = db.transaction(() => {
    // 200 rows so the heavy genres dwarf the niche ones — gives the bar/pie
    // panels a clearly skewed distribution.
    for (let i = 0; i < 200; i += 1) {
      const wA = TITLE_WORDS_A[Math.floor(rand() * TITLE_WORDS_A.length)]!
      const wB = TITLE_WORDS_B[Math.floor(rand() * TITLE_WORDS_B.length)]!
      const title = `${wA} ${wB}`
      const artist = ARTISTS[Math.floor(rand() * ARTISTS.length)]!
      const genre = pickWeighted(rand, genreItems)
      const lengthSec = 90 + Math.floor(rand() * 360) // 1.5 – 7.5 min
      const plays = Math.floor(Math.pow(rand(), 1.6) * 50_000)
      const dayOffset = Math.floor(rand() * 365 * 3) // last ~3 years
      const ts = new Date(Date.now() - dayOffset * 86_400_000)
      insert.run(teamId, title, artist, genre, lengthSec, plays, ts.toISOString().slice(0, 10))
    }
  })
  tx()
}

function main() {
  const args = parseArgs()
  const companySlug = pickCompany(args.company)
  const team = pickTeam(companySlug, args.team)
  const dbPath = path.join(hiveRoot(), 'companies', companySlug, 'data.db')
  console.log(`hive: ${hiveRoot()}`)
  console.log(`company: ${companySlug}`)
  console.log(`team:    ${team.slug} (${team.id})`)
  console.log(`db:      ${dbPath}`)

  const db = new Database(dbPath)
  try {
    ensureCustomerTable(db)
    seedCustomer(db, team.id)
    const cn = db.prepare('SELECT COUNT(*) AS n FROM customer WHERE team_id = ?').get(team.id) as { n: number }
    console.log(`seeded customer: ${cn.n} rows`)
    ensureTrackTable(db)
    seedTrack(db, team.id)
    const tn = db.prepare('SELECT COUNT(*) AS n FROM track WHERE team_id = ?').get(team.id) as { n: number }
    const distinct = db.prepare(
      'SELECT genre, COUNT(*) AS c FROM track WHERE team_id = ? GROUP BY genre ORDER BY c DESC',
    ).all(team.id) as { genre: string; c: number }[]
    console.log(`seeded track:    ${tn.n} rows across ${distinct.length} genres`)
    for (const r of distinct) console.log(`  - ${r.genre}: ${r.c}`)
  } finally {
    db.close()
  }
}

main()
