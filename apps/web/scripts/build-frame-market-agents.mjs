#!/usr/bin/env node
// Convert AGENT.md bundles in packages/frame-market/agents/<slug>/ into
// <slug>.openhive-agent-frame.yaml files alongside, and register them in
// packages/frame-market/index.json.
//
// Idempotent: re-running rewrites the YAMLs and rewrites the agents[] list.

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const agentsDir = path.join(repoRoot, 'packages/frame-market/agents')
const indexPath = path.join(repoRoot, 'packages/frame-market/index.json')

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: md }
  return { fm: yaml.load(m[1]) ?? {}, body: m[2] }
}

function titleCase(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function bundleFiles(dir) {
  const files = {}
  function walk(abs, rel) {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(a, r)
      else if (e.isFile() && a.endsWith('.md')) files[r] = fs.readFileSync(a, 'utf8')
    }
  }
  walk(dir, '')
  return files
}

const entries = fs
  .readdirSync(agentsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

const indexEntries = []
for (const slug of entries) {
  const dir = path.join(agentsDir, slug)
  const agentMdPath = path.join(dir, 'AGENT.md')
  if (!fs.existsSync(agentMdPath)) continue
  const md = fs.readFileSync(agentMdPath, 'utf8')
  const { fm } = parseFrontmatter(md)
  const description = typeof fm.description === 'string' ? fm.description : ''
  const descriptionI18n = {}
  const nameI18n = {}
  for (const [k, v] of Object.entries(fm)) {
    let m = /^description_([a-z]{2})$/.exec(k)
    if (m && typeof v === 'string' && v) {
      descriptionI18n[m[1]] = v
      continue
    }
    m = /^name_([a-z]{2})$/.exec(k)
    if (m && typeof v === 'string' && v) nameI18n[m[1]] = v
  }
  const icon = typeof fm.icon === 'string' && fm.icon ? fm.icon : 'users'
  const displayName = titleCase(slug)
  const files = bundleFiles(dir)

  const frame = {
    openhive_agent_frame: 1,
    name: displayName,
    description,
    version: '1.0.0',
    created_at: new Date().toISOString(),
    tags: ['generic', slug],
    agent: {
      role: slug,
      label: displayName,
      icon,
      model: '',
      system_prompt: '',
      skills: [],
      max_parallel: 1,
      persona_bundle_key: slug,
    },
    persona_assets: {
      [slug]: { name: slug, files },
    },
    requires: { skills: [], providers: [] },
  }

  const yamlText = yaml.dump(frame, { lineWidth: 100, noRefs: true })
  const outPath = path.join(dir, `${slug}.openhive-agent-frame.yaml`)
  fs.writeFileSync(outPath, yamlText, 'utf8')

  indexEntries.push({
    id: slug,
    name: displayName,
    name_i18n: nameI18n,
    description,
    description_i18n: descriptionI18n,
    author: 'OpenHive',
    tags: ['generic', slug],
    icon,
  })
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
index.agents = indexEntries
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8')

console.log(`Wrote ${indexEntries.length} agent frames + index.`)
