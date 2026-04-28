/**
 * Per-team dashboard layout store. Ports apps/server/openhive/persistence/
 * dashboards.py — the frontend owns the block-type vocabulary; this just
 * persists the blob at companies/{c}/teams/{t}/dashboard.yaml.
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { teamDir } from './paths'

function dashboardPath(companySlug: string, teamSlug: string): string {
  const dir = teamDir(companySlug, teamSlug)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'dashboard.yaml')
}

export function loadDashboard(
  companySlug: string,
  teamSlug: string,
): Record<string, unknown> | null {
  const p = dashboardPath(companySlug, teamSlug)
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null
  const raw = yaml.load(fs.readFileSync(p, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

const BACKUP_KEEP = 10

function rotateBackups(p: string): void {
  if (!fs.existsSync(p)) return
  const dir = path.dirname(p)
  const base = path.basename(p)
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.v`))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  // Keep newest BACKUP_KEEP-1 so that the one we're about to write stays within quota.
  for (const extra of backups.slice(BACKUP_KEEP - 1)) {
    try {
      fs.unlinkSync(path.join(dir, extra.name))
    } catch {
      /* ignore */
    }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(p, path.join(dir, `${base}.v${ts}`))
}

/**
 * Minimum refresh cadence per source kind. Caps AI or user misconfiguration
 * from hammering upstream APIs. Applied silently on save — UI can still show
 * whatever the user typed, but the server clamps it.
 */
const MIN_REFRESH_SECONDS: Record<string, number> = {
  http: 60,
  http_recipe: 60,
  http_raw: 60,
  mcp: 30,
  team_data: 10,
  team_file: 5,
  static: 0,
}

function clampRefreshRates(layout: Record<string, unknown>): Record<string, unknown> {
  const blocks = layout.blocks
  if (!Array.isArray(blocks)) return layout
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const binding = b.binding as Record<string, unknown> | undefined
    if (!binding) continue
    const source = binding.source as Record<string, unknown> | undefined
    const kind = typeof source?.kind === 'string' ? source.kind : ''
    const min = MIN_REFRESH_SECONDS[kind] ?? 30
    const requested = Number(binding.refresh_seconds ?? 0)
    if (requested !== 0 && requested < min) {
      binding.refresh_seconds = min
    }
  }
  return layout
}

function hasBoundBlock(layout: Record<string, unknown>): boolean {
  const blocks = layout.blocks
  if (!Array.isArray(blocks)) return false
  for (const b of blocks) {
    if (b && typeof b === 'object' && !Array.isArray(b) && (b as Record<string, unknown>).binding) {
      return true
    }
  }
  return false
}

export function saveDashboard(
  companySlug: string,
  teamSlug: string,
  layout: Record<string, unknown>,
): void {
  const p = dashboardPath(companySlug, teamSlug)
  rotateBackups(p)
  const clamped = clampRefreshRates(layout)
  fs.writeFileSync(
    p,
    yaml.dump(clamped, { noRefs: true, sortKeys: false }),
    'utf8',
  )
  // Ensure the scheduler is armed now that this dashboard has bindings. Boot
  // scans for panels and adds the `panels:refresh` routine, but panels added
  // after boot need to announce themselves or their refresh cadence stays
  // dormant and the UI just shows last-successful-fetch forever.
  if (hasBoundBlock(clamped)) {
    try {
      // Lazy-require to avoid a boot-time circular import.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import for cycle-breaking
      const mod = require('./scheduler/scheduler') as {
        getScheduler: () => { addRoutine: (r: { id: string; cron?: string }) => void }
      }
      mod.getScheduler().addRoutine({ id: 'panels:refresh' })
    } catch {
      /* scheduler may not be initialised yet in some code paths — fine */
    }
  }
}

interface DashboardBackup {
  name: string
  saved_at: number
}

export function listDashboardBackups(
  companySlug: string,
  teamSlug: string,
): DashboardBackup[] {
  const p = dashboardPath(companySlug, teamSlug)
  const dir = path.dirname(p)
  const base = path.basename(p)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.v`))
    .map((f) => ({
      name: f,
      saved_at: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.saved_at - a.saved_at)
}

export function restoreDashboardBackup(
  companySlug: string,
  teamSlug: string,
  backupName: string,
): boolean {
  const p = dashboardPath(companySlug, teamSlug)
  const dir = path.dirname(p)
  const base = path.basename(p)
  if (!backupName.startsWith(`${base}.v`) || backupName.includes('/')) return false
  const src = path.join(dir, backupName)
  if (!fs.existsSync(src)) return false
  rotateBackups(p)
  fs.copyFileSync(src, p)
  return true
}
