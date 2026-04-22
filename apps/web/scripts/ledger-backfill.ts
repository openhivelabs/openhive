#!/usr/bin/env tsx
/**
 * S4 Phase 4 — ledger backfill (STUB).
 *
 * Scans `~/.openhive/sessions/{id}/events.jsonl` for `delegation_closed`
 * events and would INSERT them into the per-company ledger. This stub only
 * prints a dry-run plan — the actual write path lands in a follow-up plan.
 *
 * Usage:
 *   pnpm openhive:ledger:backfill [--company <slug>] [--dry-run]
 */

import fs from 'node:fs'
import path from 'node:path'
import { sessionsRoot } from '../lib/server/paths'

interface Args {
  company: string | null
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { company: null, dryRun: true }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') {
      out.dryRun = true
    } else if (a === '--apply') {
      out.dryRun = false
    } else if (a === '--company' && argv[i + 1]) {
      out.company = String(argv[i + 1])
      i += 1
    }
  }
  return out
}

function listSessionDirs(): string[] {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
}

function countDelegationClosed(sessionDir: string): number {
  const eventsPath = path.join(sessionDir, 'events.jsonl')
  if (!fs.existsSync(eventsPath)) return 0
  let n = 0
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n')
  for (const line of lines) {
    if (!line) continue
    try {
      const ev = JSON.parse(line) as { kind?: string; data?: { error?: boolean } }
      if (ev.kind === 'delegation_closed' && !ev.data?.error) n += 1
    } catch {
      /* ignore malformed */
    }
  }
  return n
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  console.log('[ledger-backfill] STUB — dry-run plan only')
  console.log(`  company filter: ${args.company ?? '(all)'}`)
  console.log(`  mode:           ${args.dryRun ? 'dry-run' : 'apply (NOT IMPLEMENTED)'}`)
  const sessions = listSessionDirs()
  console.log(`  sessions found: ${sessions.length}`)
  let totalCandidates = 0
  for (const dir of sessions) {
    const n = countDelegationClosed(dir)
    if (n > 0) {
      totalCandidates += n
      console.log(`    ${path.basename(dir)}: ${n} candidate entr${n === 1 ? 'y' : 'ies'}`)
    }
  }
  console.log(`  total candidates: ${totalCandidates}`)
  if (!args.dryRun) {
    console.error('[ledger-backfill] --apply is not implemented yet (Phase 4 stub).')
    process.exitCode = 1
  }
}

main()
