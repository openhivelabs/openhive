/**
 * Work ledger write path.
 *
 * Called from `runDelegation` / `runParallelDelegation` right before the
 * `delegation_closed` event is emitted — see session.ts hooks at lines
 * ~1112 (single completed), ~1098 (single errored), ~1310 (parallel).
 *
 * Failures are swallowed (console.warn) so ledger issues never take down a
 * run. Toggle off entirely with `OPENHIVE_LEDGER_DISABLED=1`.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AgentSpec, TeamSpec } from '../engine/team'
import { isLedgerDisabled, ledgerDir, withLedgerDb } from './db'
import { ulid } from './ulid'

export interface WriteLedgerOpts {
  sessionId: string
  team: TeamSpec
  target: AgentSpec
  task: string
  output: string
  status: 'completed' | 'errored' | 'cancelled'
  companySlug: string
}

/**
 * Regex capturing artifact paths that a sub-agent mentions in its output —
 * tilde-anchored or absolute, containing `/artifacts/`. Best-effort only.
 */
const ARTIFACT_RE = /(~?\/[\w./-]+\/artifacts\/[\w./-]+)/g

export function extractArtifactPaths(output: string): string[] {
  const seen = new Set<string>()
  for (const m of output.matchAll(ARTIFACT_RE)) {
    if (m[1]) seen.add(m[1])
  }
  return Array.from(seen)
}

export function heuristicSummary(output: string, artifacts: string[]): string {
  const trimmed = output.trim()
  if (trimmed.length === 0) return '(empty output)'
  if (trimmed.length <= 700) return trimmed
  const head = trimmed.slice(0, 500).trim()
  const tail = trimmed.slice(-200).trim()
  const files = artifacts
    .map((p) => p.split('/').pop())
    .filter(Boolean)
    .join(', ')
  const note = files ? `\n[artifacts: ${files}]` : ''
  return `${head}\n…\n${tail}${note}`
}

export function bodyRelativePath(id: string, ts: number): string {
  const d = new Date(ts * 1000)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `entries/${yyyy}/${mm}/${id}.md`
}

function renderBody(args: {
  id: string
  ts: number
  opts: WriteLedgerOpts
  artifacts: string[]
  summary: string
  domain: string
}): string {
  const { id, ts, opts, artifacts, summary, domain } = args
  const lines: string[] = [
    '---',
    `id: ${id}`,
    `ts: ${ts}`,
    `session_id: ${opts.sessionId}`,
    `team_id: ${opts.team.id}`,
    `agent_id: ${opts.target.id}`,
    `agent_role: ${opts.target.role}`,
    `domain: ${domain}`,
    `status: ${opts.status}`,
    'task_excerpt: |',
  ]
  for (const l of opts.task.slice(0, 400).split('\n')) lines.push(`  ${l}`)
  lines.push('artifact_paths:')
  if (artifacts.length > 0) {
    for (const p of artifacts) lines.push(`  - ${p}`)
  } else {
    lines.push('  []')
  }
  lines.push(
    '---',
    '',
    '# Task',
    '',
    opts.task,
    '',
    '# Summary',
    '',
    summary,
    '',
    '# Output',
    '',
    opts.output,
  )
  return lines.join('\n')
}

export async function maybeWriteLedger(opts: WriteLedgerOpts): Promise<void> {
  if (isLedgerDisabled()) return
  if (opts.status === 'errored' && process.env.OPENHIVE_LEDGER_ERRORS === '0') {
    return
  }
  if (!opts.companySlug) return
  try {
    const ts = Math.floor(Date.now() / 1000)
    const id = ulid()
    const artifacts = extractArtifactPaths(opts.output)
    const summary = heuristicSummary(opts.output, artifacts)
    const teamWithDomain = opts.team as TeamSpec & { domain?: string }
    const domain = teamWithDomain.domain ?? opts.team.id
    const bodyRel = bodyRelativePath(id, ts)
    const bodyAbs = path.join(ledgerDir(opts.companySlug), bodyRel)
    fs.mkdirSync(path.dirname(bodyAbs), { recursive: true })
    fs.writeFileSync(bodyAbs, renderBody({ id, ts, opts, artifacts, summary, domain }))
    withLedgerDb(opts.companySlug, (db) => {
      db.prepare(
        `INSERT INTO entries (
          id, ts, session_id, team_id, agent_id, agent_role,
          domain, task, summary, artifact_paths, body_path, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        ts,
        opts.sessionId,
        opts.team.id,
        opts.target.id,
        opts.target.role,
        domain,
        opts.task,
        summary,
        JSON.stringify(artifacts),
        bodyRel,
        opts.status,
      )
    })
  } catch (e) {
    // Never take down the run for a ledger failure.
    console.warn('[ledger] write failed', e)
  }
}

/**
 * Stub for `OPENHIVE_LEDGER_SUMMARY=llm` — deferred per ADDENDUM.
 * Interface preserved so future S4 follow-up can wire it without touching
 * the write path.
 */
export async function llmSummary(_opts: {
  output: string
  task: string
  team: TeamSpec
  target: AgentSpec
}): Promise<string> {
  throw new Error('OPENHIVE_LEDGER_SUMMARY=llm not yet implemented')
}
