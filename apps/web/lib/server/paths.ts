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

/**
 * @deprecated Team-scoped DBs are being merged into a single company-scoped
 * `data.db`. This helper is retained only for the one-shot migration script;
 * runtime code should use {@link companyDataDbPath} and carry `team_id` as a
 * bound parameter.
 */
export function teamDataDbPath(companySlug: string, teamSlug: string): string {
  return path.join(teamDir(companySlug, teamSlug), 'data.db')
}

/** Company-scoped domain DB. Holds all teams' user tables with a `team_id`
 *  column as the soft namespace. Resolves to `companies/<c>/data.db`. */
export function companyDataDbPath(companySlug: string): string {
  return path.join(companyDir(companySlug), 'data.db')
}

/** Company-scoped shared files pool (readable by any team). Team-private
 *  files continue to live under {@link teamDir}/files/. */
export function companyFilesDir(companySlug: string): string {
  return path.join(companyDir(companySlug), 'files')
}

export function artifactsRoot(): string {
  return path.join(dataDir(), 'artifacts')
}

export function sessionsRoot(): string {
  return path.join(dataDir(), 'sessions')
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

/** Root for AI-generated user MCP servers.
 *  Each subdir holds server.js + manifest.json + package.json + .approved. */
export function userMcpDir(): string {
  return path.join(dataDir(), 'mcp-user')
}

/** Absolute path to the web app's node_modules, where `@modelcontextprotocol/sdk`
 *  is already installed. We symlink this into `userMcpDir()/node_modules` so
 *  AI-generated MCP server.user.js can `require('@modelcontextprotocol/sdk')`
 *  without us running `npm install` per server. */
export function webAppNodeModules(): string {
  // paths.ts in dev is executed with cwd = apps/web, so node_modules sits
  // next to it. In prod standalone, the tree differs — caller should tolerate
  // a missing path and fall back to NODE_PATH injection.
  const cwd = process.cwd()
  const direct = path.join(cwd, 'node_modules')
  if (fs.existsSync(path.join(direct, '@modelcontextprotocol', 'sdk'))) return direct
  const fromRepo = path.join(repoRoot(), 'apps', 'web', 'node_modules')
  return fromRepo
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
