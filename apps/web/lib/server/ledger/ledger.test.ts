/**
 * Unit tests for the S4 work ledger (schema + db + ulid + write + read).
 * Uses an `OPENHIVE_DATA_DIR` tmp dir per test so no two tests share state.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSpec, TeamSpec } from '../engine/team'
import { __resetLedgerCache, ledgerDir, withLedgerDb } from './db'
import { readLedgerEntry, searchLedger } from './read'
import { ulid } from './ulid'
import { bodyRelativePath, extractArtifactPaths, heuristicSummary, maybeWriteLedger } from './write'

const COMPANY = 'acme'

function mkTeam(overrides: Partial<TeamSpec> = {}): TeamSpec {
  return {
    id: 'research-team',
    name: 'Research',
    agents: [],
    edges: [],
    entry_agent_id: null,
    allowed_skills: [],
    allowed_mcp_servers: [],
    limits: { max_tool_rounds_per_turn: 8, max_delegation_depth: 4 },
    ...overrides,
  }
}

function mkAgent(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'ag-1',
    role: 'Researcher',
    label: 'Researcher',
    provider_id: 'claude-code',
    model: 'claude-opus-4-7',
    system_prompt: '',
    skills: [],
    max_parallel: 1,
    persona_path: null,
    persona_name: null,
    ...overrides,
  }
}

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-ledger-'))
  process.env.OPENHIVE_DATA_DIR = tmp
  process.env.OPENHIVE_LEDGER_DISABLED = undefined
  process.env.OPENHIVE_LEDGER_ERRORS = undefined
  __resetLedgerCache()
})

afterEach(() => {
  __resetLedgerCache()
  fs.rmSync(tmp, { recursive: true, force: true })
  process.env.OPENHIVE_DATA_DIR = undefined
  process.env.OPENHIVE_LEDGER_DISABLED = undefined
  process.env.OPENHIVE_LEDGER_ERRORS = undefined
})

describe('ulid', () => {
  it('emits 10k unique ids', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i += 1) seen.add(ulid())
    expect(seen.size).toBe(10_000)
  })

  it('sorts lexicographically by timestamp', () => {
    const earlier = ulid(1_700_000_000_000)
    const later = ulid(1_800_000_000_000)
    expect(earlier < later).toBe(true)
  })

  it('produces 26-char Crockford base32', () => {
    const id = ulid()
    expect(id.length).toBe(26)
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)).toBe(true)
  })
})

describe('write helpers', () => {
  it('heuristicSummary passes short output unchanged', () => {
    expect(heuristicSummary('short result', [])).toBe('short result')
  })

  it('heuristicSummary collapses long output to head…tail + files', () => {
    const long = 'a'.repeat(2_000)
    const out = heuristicSummary(long, ['~/.openhive/sessions/x/artifacts/foo.csv'])
    expect(out.includes('…')).toBe(true)
    expect(out.includes('foo.csv')).toBe(true)
  })

  it('heuristicSummary handles empty output gracefully', () => {
    expect(heuristicSummary('   ', [])).toBe('(empty output)')
  })

  it('extractArtifactPaths picks tilde and absolute artifact paths', () => {
    const out =
      'Saved ~/.openhive/sessions/abc/artifacts/report.md and also /tmp/work/artifacts/data.csv here.'
    const paths = extractArtifactPaths(out)
    expect(paths.length).toBe(2)
    expect(paths.some((p) => p.endsWith('report.md'))).toBe(true)
    expect(paths.some((p) => p.endsWith('data.csv'))).toBe(true)
  })

  it('bodyRelativePath yields entries/{yyyy}/{mm}/{id}.md', () => {
    const rel = bodyRelativePath('01HXABC', Math.floor(Date.UTC(2026, 3, 5) / 1000))
    expect(rel).toBe('entries/2026/04/01HXABC.md')
  })
})

describe('withLedgerDb', () => {
  it('creates index.db + v1 migration row on first open', () => {
    withLedgerDb(COMPANY, (db) => {
      const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get() as
        | { version: number }
        | undefined
      expect(row?.version).toBe(1)
    })
    const dbPath = path.join(ledgerDir(COMPANY), 'index.db')
    expect(fs.existsSync(dbPath)).toBe(true)
  })

  it('returns the same cached instance across calls', () => {
    const first = withLedgerDb(COMPANY, (db) => db)
    const second = withLedgerDb(COMPANY, (db) => db)
    expect(first).toBe(second)
  })

  it('throws when OPENHIVE_LEDGER_DISABLED=1', () => {
    process.env.OPENHIVE_LEDGER_DISABLED = '1'
    expect(() => withLedgerDb(COMPANY, () => 0)).toThrow(/disabled/)
  })
})

describe('maybeWriteLedger', () => {
  it('writes a completed entry + body file', async () => {
    const team = mkTeam()
    const target = mkAgent()
    await maybeWriteLedger({
      sessionId: 'sess-1',
      team,
      target,
      task: 'draft the Q3 report outline',
      output: 'done.',
      status: 'completed',
      companySlug: COMPANY,
    })
    const rows = withLedgerDb(COMPANY, (db) =>
      db.prepare('SELECT id, body_path, status, domain FROM entries').all(),
    ) as Array<{ id: string; body_path: string; status: string; domain: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]?.status).toBe('completed')
    // domain falls back to team.id when team.domain not set.
    expect(rows[0]?.domain).toBe('research-team')
    const bodyAbs = path.join(ledgerDir(COMPANY), rows[0]?.body_path)
    expect(fs.existsSync(bodyAbs)).toBe(true)
    const body = fs.readFileSync(bodyAbs, 'utf8')
    expect(body.includes('# Task')).toBe(true)
    expect(body.includes('draft the Q3 report outline')).toBe(true)
  })

  it('honors team.domain when set', async () => {
    await maybeWriteLedger({
      sessionId: 'sess-2',
      team: mkTeam({ domain: 'research' }),
      target: mkAgent(),
      task: 't',
      output: 'o',
      status: 'completed',
      companySlug: COMPANY,
    })
    const rows = withLedgerDb(COMPANY, (db) =>
      db.prepare('SELECT domain FROM entries').all(),
    ) as Array<{ domain: string }>
    expect(rows[0]?.domain).toBe('research')
  })

  it('is a no-op under OPENHIVE_LEDGER_DISABLED=1', async () => {
    process.env.OPENHIVE_LEDGER_DISABLED = '1'
    await maybeWriteLedger({
      sessionId: 'x',
      team: mkTeam(),
      target: mkAgent(),
      task: 't',
      output: 'o',
      status: 'completed',
      companySlug: COMPANY,
    })
    expect(fs.existsSync(path.join(ledgerDir(COMPANY), 'index.db'))).toBe(false)
  })

  it('skips errored entries when OPENHIVE_LEDGER_ERRORS=0', async () => {
    process.env.OPENHIVE_LEDGER_ERRORS = '0'
    await maybeWriteLedger({
      sessionId: 'x',
      team: mkTeam(),
      target: mkAgent(),
      task: 't',
      output: 'failed',
      status: 'errored',
      companySlug: COMPANY,
    })
    expect(fs.existsSync(path.join(ledgerDir(COMPANY), 'index.db'))).toBe(false)
  })
})

describe('searchLedger + readLedgerEntry', () => {
  async function seed(): Promise<void> {
    const team = mkTeam({ domain: 'research' })
    const salesTeam = mkTeam({ id: 'sales-team', domain: 'sales' })
    const agentA = mkAgent({ id: 'a', role: 'Researcher' })
    const agentB = mkAgent({ id: 'b', role: 'Writer' })
    await maybeWriteLedger({
      sessionId: 's1',
      team,
      target: agentA,
      task: 'Q3 매출 보고서 경쟁사 조사',
      output: '경쟁사 A, B, C 가격 정리.',
      status: 'completed',
      companySlug: COMPANY,
    })
    await maybeWriteLedger({
      sessionId: 's1',
      team,
      target: agentB,
      task: 'finalize cover letter draft',
      output: 'letter draft v1',
      status: 'completed',
      companySlug: COMPANY,
    })
    await maybeWriteLedger({
      sessionId: 's2',
      team: salesTeam,
      target: agentA,
      task: 'pipeline review notes',
      output: 'pipeline summary',
      status: 'completed',
      companySlug: COMPANY,
    })
    await maybeWriteLedger({
      sessionId: 's2',
      team,
      target: agentA,
      task: 'errored run example',
      output: 'boom',
      status: 'errored',
      companySlug: COMPANY,
    })
  }

  it('matches by FTS keyword', async () => {
    await seed()
    const res = searchLedger(COMPANY, { query: '매출' })
    expect(res.results.length).toBeGreaterThanOrEqual(1)
    expect(res.results[0]?.task.includes('매출')).toBe(true)
    expect(res.total_matched).toBeGreaterThanOrEqual(1)
  })

  it('filters by domain', async () => {
    await seed()
    const res = searchLedger(COMPANY, { query: 'pipeline', domain: 'sales' })
    expect(res.results.length).toBe(1)
    expect(res.results[0]?.domain).toBe('sales')
  })

  it('filters by agent_role', async () => {
    await seed()
    const res = searchLedger(COMPANY, { query: 'cover', agent_role: 'Writer' })
    expect(res.results.length).toBe(1)
    expect(res.results[0]?.agent_role).toBe('Writer')
  })

  it('clamps limit to 1..50', async () => {
    await seed()
    const res = searchLedger(COMPANY, {
      query: 'a OR b OR c OR report OR notes OR draft OR pipeline OR 매출',
      limit: 999,
    })
    expect(res.results.length).toBeLessThanOrEqual(50)
  })

  it('throws a friendly error on bad FTS syntax', async () => {
    await seed()
    expect(() => searchLedger(COMPANY, { query: '"unterminated' })).toThrow(/ledger search failed/)
  })

  it('reads full body by id and throws on missing', async () => {
    await seed()
    const res = searchLedger(COMPANY, { query: '매출' })
    const id = res.results[0]?.id
    const read = readLedgerEntry(COMPANY, id)
    expect(read.meta.id).toBe(id)
    expect(read.full_body.includes('# Task')).toBe(true)
    expect(() => readLedgerEntry(COMPANY, 'nope-nope-nope')).toThrow(/not found/)
  })

  it('orders results by ts DESC', async () => {
    await seed()
    const res = searchLedger(COMPANY, { query: 'Researcher OR Writer OR pipeline OR 매출' })
    for (let i = 1; i < res.results.length; i += 1) {
      expect(res.results[i - 1]?.ts >= res.results[i]?.ts).toBe(true)
    }
  })
})

describe('performance', () => {
  it('100-entry seed search completes under 50ms', async () => {
    const team = mkTeam({ domain: 'research' })
    const target = mkAgent()
    for (let i = 0; i < 100; i += 1) {
      await maybeWriteLedger({
        sessionId: `s-${i}`,
        team,
        target,
        task: `task number ${i} about quarterly report analysis`,
        output:
          `output body number ${i} with some filler text to simulate realistic summary lengths `.repeat(
            10,
          ),
        status: 'completed',
        companySlug: COMPANY,
      })
    }
    const start = performance.now()
    const res = searchLedger(COMPANY, { query: 'quarterly' })
    const ms = performance.now() - start
    expect(res.results.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(50)
  })
})
