/**
 * Team chat messages — stored as append-only JSONL per team.
 *
 *   ~/.openhive/companies/{company}/teams/{team}/chat.jsonl
 *
 * One line per message. We look up the company+team slugs by scanning
 * team.yaml files and matching `id:`. Messages whose team can't be found
 * go to a sidecar orphan file so nothing is silently lost.
 */

import fs from 'node:fs'
import path from 'node:path'
import { companyDir, dataDir } from './paths'

export interface MessageRecord {
  id: string
  team_id: string
  from_id: string
  text: string
  session_id: string | null
  created_at: number
}

function pathForTeam(teamId: string): string {
  const root = path.join(dataDir(), 'companies')
  if (fs.existsSync(root)) {
    const companies = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    for (const c of companies) {
      const teamsRoot = path.join(companyDir(c.name), 'teams')
      if (!fs.existsSync(teamsRoot)) continue
      const teams = fs
        .readdirSync(teamsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
      for (const t of teams) {
        try {
          const yamlTxt = fs.readFileSync(path.join(teamsRoot, t.name, 'team.yaml'), 'utf8')
          if (new RegExp(`^id:\\s*['\"]?${teamId}['\"]?\\s*$`, 'm').test(yamlTxt)) {
            return path.join(teamsRoot, t.name, 'chat.jsonl')
          }
        } catch { /* skip */ }
      }
    }
  }
  return path.join(dataDir(), 'cache', 'orphan-messages', `${teamId}.jsonl`)
}

function readAll(file: string): MessageRecord[] {
  if (!fs.existsSync(file)) return []
  const out: MessageRecord[] = []
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as MessageRecord) } catch { /* skip */ }
  }
  return out
}

function writeAll(file: string, rows: MessageRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const text = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function saveMessage(record: MessageRecord): void {
  const file = pathForTeam(record.team_id)
  const existing = readAll(file)
  const idx = existing.findIndex((m) => m.id === record.id)
  if (idx >= 0) {
    existing[idx] = record
    writeAll(file, existing)
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  }
}

export function listForTeam(teamId: string, limit = 500): MessageRecord[] {
  const rows = readAll(pathForTeam(teamId))
  rows.sort((a, b) => a.created_at - b.created_at)
  return rows.slice(-limit)
}

export function clearTeam(teamId: string): number {
  const file = pathForTeam(teamId)
  if (!fs.existsSync(file)) return 0
  const n = readAll(file).length
  try { fs.unlinkSync(file) } catch { /* ignore */ }
  return n
}

export function nowTs(): number {
  return Date.now()
}
