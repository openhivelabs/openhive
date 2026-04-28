/**
 * Single-slot team snapshot (safety net for AI edit sessions). Ports
 * apps/server/openhive/persistence/snapshots.py.
 */

import fs from 'node:fs'
import path from 'node:path'
import { teamDir } from './paths'

const SNAP_DIR = '_snapshot'
const TRACKED_FILES = ['data.db', 'dashboard.yaml'] as const

function base(companySlug: string, teamSlug: string): string {
  return teamDir(companySlug, teamSlug)
}

export function createSnapshot(
  companySlug: string,
  teamSlug: string,
): Record<string, boolean> {
  const b = base(companySlug, teamSlug)
  const snap = path.join(b, SNAP_DIR)
  if (fs.existsSync(snap)) fs.rmSync(snap, { recursive: true, force: true })
  fs.mkdirSync(snap, { recursive: true })
  const result: Record<string, boolean> = {}
  for (const name of TRACKED_FILES) {
    const src = path.join(b, name)
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(snap, name))
      result[name] = true
    } else {
      result[name] = false
    }
  }
  return result
}

interface RestoreResult extends Record<string, boolean> {
  ok: boolean
}

export function restoreSnapshot(
  companySlug: string,
  teamSlug: string,
): RestoreResult {
  const b = base(companySlug, teamSlug)
  const snap = path.join(b, SNAP_DIR)
  if (!fs.existsSync(snap) || !fs.statSync(snap).isDirectory()) {
    return { ok: false }
  }
  const result: RestoreResult = { ok: true }
  for (const name of TRACKED_FILES) {
    const s = path.join(snap, name)
    if (fs.existsSync(s) && fs.statSync(s).isFile()) {
      fs.copyFileSync(s, path.join(b, name))
      result[name] = true
    }
  }
  return result
}

export function discardSnapshot(
  companySlug: string,
  teamSlug: string,
): boolean {
  const snap = path.join(base(companySlug, teamSlug), SNAP_DIR)
  if (fs.existsSync(snap) && fs.statSync(snap).isDirectory()) {
    fs.rmSync(snap, { recursive: true, force: true })
    return true
  }
  return false
}

export function hasSnapshot(
  companySlug: string,
  teamSlug: string,
): boolean {
  const snap = path.join(base(companySlug, teamSlug), SNAP_DIR)
  return fs.existsSync(snap) && fs.statSync(snap).isDirectory()
}
