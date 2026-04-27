#!/usr/bin/env node
// One-shot release: bump apps/web/package.json, commit, tag, push.
// GitHub Actions takes over from there and publishes to npm.
//
// Usage:
//   pnpm release patch     # 0.1.1 → 0.1.2  (bug fix)
//   pnpm release minor     # 0.1.2 → 0.2.0  (feature)
//   pnpm release major     # 0.2.0 → 1.0.0  (breaking)
//   pnpm release 0.5.0     # exact version

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const bump = process.argv[2] ?? 'patch'
const pkgPath = path.resolve('apps/web/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const [maj, min, pat] = current.split('.').map(Number)
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`
  throw new Error(`unknown bump: ${kind} (use patch/minor/major or x.y.z)`)
}

function run(cmd) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit' })
}

function check(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

// Refuse if working tree is dirty — releases off uncommitted state make the
// tag point at a snapshot the user can't reproduce.
const status = check('git status --porcelain')
if (status) {
  console.error('working tree has uncommitted changes — commit or stash first:')
  console.error(status)
  process.exit(1)
}

const branch = check('git rev-parse --abbrev-ref HEAD')
if (branch !== 'main') {
  console.error(`releases must run on main (current: ${branch})`)
  process.exit(1)
}

const next = nextVersion(pkg.version, bump)
console.log(`bumping ${pkg.version} → ${next}`)

pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

run('git add apps/web/package.json')
run(`git commit -m "chore(release): v${next}"`)
run(`git tag v${next}`)
run('git push origin main')
run(`git push origin v${next}`)

console.log(`\n✅ tagged v${next} and pushed.`)
console.log('   GitHub Actions → "Publish openhiveai to npm" will publish in ~1 min.')
console.log('   watch: gh run watch --workflow=publish.yml')
