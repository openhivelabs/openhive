/**
 * Filesystem path helpers for ~/.openhive/. Single source of truth for the
 * TS backend. Mirrors what apps/server/openhive/persistence/* reaches for
 * in Python today.
 */

import fs from 'node:fs'
import path from 'node:path'
import { getSettings } from './config'

export function dataDir(): string {
  const dir = getSettings().dataDir
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function dbPath(): string {
  return path.join(dataDir(), 'openhive.db')
}

export function encryptionKeyPath(): string {
  return path.join(dataDir(), 'encryption.key')
}

export function companiesRoot(): string {
  return path.join(dataDir(), 'companies')
}

export function companyDir(slug: string): string {
  return path.join(companiesRoot(), slug)
}

/**
 * Team config YAML (companies/{c}/teams/{slug}.yaml). Flat file — siblings
 * coexist with the per-team directory below.
 */
export function teamYamlPath(companySlug: string, teamSlug: string): string {
  return path.join(companyDir(companySlug), 'teams', `${teamSlug}.yaml`)
}

/**
 * Per-team directory (companies/{c}/teams/{slug}/). Holds `dashboard.yaml`,
 * `data.db`, persona bundles, etc. Distinct from the sibling team YAML file.
 */
export function teamDir(companySlug: string, teamSlug: string): string {
  return path.join(companyDir(companySlug), 'teams', teamSlug)
}

export function teamDataDbPath(companySlug: string, teamSlug: string): string {
  return path.join(teamDir(companySlug, teamSlug), 'data.db')
}

export function artifactsRoot(): string {
  return path.join(dataDir(), 'artifacts')
}

export function skillsRoot(): string {
  return path.join(dataDir(), 'skills')
}

export function globalConfigPath(): string {
  return path.join(dataDir(), 'config.yaml')
}

export function mcpConfigPath(): string {
  return path.join(dataDir(), 'mcp.yaml')
}

/** Walk up from `apps/web/` to the repo root so we can reach packages/. */
export function repoRoot(): string {
  // This file ends up at apps/web/lib/server/paths.ts (src) or .next/.../paths.js (built).
  // In both cases, the process cwd at runtime is the web app's root in dev,
  // and for prod standalone it's the standalone dir. We anchor off
  // process.cwd() + two parents when needed.
  const cwd = process.cwd()
  // When running `next dev` from apps/web, cwd is apps/web. Repo is two up.
  const maybe = path.resolve(cwd, '..', '..')
  if (fs.existsSync(path.join(maybe, 'packages'))) return maybe
  // Fallback — run from repo root.
  if (fs.existsSync(path.join(cwd, 'packages'))) return cwd
  return maybe
}

export function packagesRoot(): string {
  return path.join(repoRoot(), 'packages')
}
