/**
 * PanelTemplate discovery — packages/panel-templates/<id>.yaml.
 * Ports apps/server/openhive/panels/templates.py.
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { packagesRoot } from '../paths'

export interface PanelTemplate {
  id: string
  name: string
  description: string
  icon: string
  category: string
  block: Record<string, unknown>
  binding_skeleton: Record<string, unknown>
  ai_prompts: Record<string, unknown>
}

function templatesRoot(): string {
  return path.join(packagesRoot(), 'panel-templates')
}

function loadOne(file: string): PanelTemplate | null {
  let raw: unknown
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  if (typeof data.id !== 'string' || !data.id) return null
  const block = data.block
  if (
    !block ||
    typeof block !== 'object' ||
    Array.isArray(block) ||
    typeof (block as Record<string, unknown>).type !== 'string'
  ) {
    return null
  }
  return {
    id: data.id,
    name: typeof data.name === 'string' && data.name ? data.name : data.id,
    description: typeof data.description === 'string' ? data.description : '',
    icon: typeof data.icon === 'string' ? data.icon : '',
    category: typeof data.category === 'string' && data.category ? data.category : 'general',
    block: block as Record<string, unknown>,
    binding_skeleton:
      data.binding_skeleton && typeof data.binding_skeleton === 'object' && !Array.isArray(data.binding_skeleton)
        ? (data.binding_skeleton as Record<string, unknown>)
        : {},
    ai_prompts:
      data.ai_prompts && typeof data.ai_prompts === 'object' && !Array.isArray(data.ai_prompts)
        ? (data.ai_prompts as Record<string, unknown>)
        : {},
  }
}

export function listTemplates(): PanelTemplate[] {
  const root = templatesRoot()
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: PanelTemplate[] = []
  const files = fs
    .readdirSync(root)
    .filter((n) => n.endsWith('.yaml'))
    .sort()
  for (const name of files) {
    const tpl = loadOne(path.join(root, name))
    if (tpl) out.push(tpl)
  }
  return out
}

export function getTemplate(id: string): PanelTemplate | null {
  return listTemplates().find((t) => t.id === id) ?? null
}
