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

export function saveDashboard(
  companySlug: string,
  teamSlug: string,
  layout: Record<string, unknown>,
): void {
  const p = dashboardPath(companySlug, teamSlug)
  fs.writeFileSync(
    p,
    yaml.dump(layout, { noRefs: true, sortKeys: false }),
    'utf8',
  )
}
