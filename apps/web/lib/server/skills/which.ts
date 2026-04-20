/**
 * Minimal `which`-style PATH lookup. Avoids pulling a dependency for something
 * we invoke a handful of times per run.
 */

import fs from 'node:fs'
import path from 'node:path'

export default function which(bin: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  const pathExt = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  const candidates = pathEnv.split(path.delimiter).filter(Boolean)
  for (const dir of candidates) {
    for (const ext of pathExt) {
      const full = path.join(dir, bin + ext)
      try {
        const stat = fs.statSync(full)
        if (stat.isFile()) {
          // Executability check — on Unix this verifies any x bit is set.
          if (process.platform === 'win32' || (stat.mode & 0o111) !== 0) {
            return full
          }
        }
      } catch {
        /* continue */
      }
    }
  }
  return null
}
