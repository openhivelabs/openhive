/**
 * MCP preset gallery. Ports apps/server/openhive/mcp/presets.py.
 *
 * Presets live at packages/mcp-presets/<id>.yaml and declare:
 *   - command + args with {{key}} placeholders for user inputs
 *   - env_template (env vars to set, same placeholders)
 *   - inputs (form fields the UI renders to collect substitution values)
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { packagesRoot } from '../paths'
import type { ServerConfig } from './config'

const PLACEHOLDER = /\{\{(\w+)\}\}/g

export interface PresetInput {
  key: string
  label: string
  type: string
  placeholder: string
  help_text: string
  required: boolean
}

export interface Preset {
  id: string
  name: string
  icon: string
  brand: string
  icon_url: string
  description: string
  command: string
  args: string[]
  env_template: Record<string, string>
  inputs: PresetInput[]
  coming_soon: boolean
}

function presetsRoot(): string {
  return path.join(packagesRoot(), 'mcp-presets')
}

function coerceInput(raw: Record<string, unknown>): PresetInput | null {
  if (typeof raw.key !== 'string' || !raw.key) return null
  return {
    key: raw.key,
    label: typeof raw.label === 'string' && raw.label ? raw.label : raw.key,
    type: typeof raw.type === 'string' && raw.type ? raw.type : 'text',
    placeholder:
      typeof raw.placeholder === 'string' ? raw.placeholder : '',
    help_text: typeof raw.help_text === 'string' ? raw.help_text : '',
    required: raw.required !== false,
  }
}

function loadOne(file: string): Preset | null {
  let raw: unknown
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  if (typeof data.id !== 'string' || !data.id) return null
  const inputsRaw = Array.isArray(data.inputs) ? (data.inputs as unknown[]) : []
  const inputs: PresetInput[] = []
  for (const r of inputsRaw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const p = coerceInput(r as Record<string, unknown>)
    if (p) inputs.push(p)
  }
  return {
    id: data.id,
    name: typeof data.name === 'string' && data.name ? data.name : data.id,
    icon: typeof data.icon === 'string' ? data.icon : '',
    brand: typeof data.brand === 'string' ? data.brand : '',
    icon_url: typeof data.icon_url === 'string' ? data.icon_url : '',
    description:
      typeof data.description === 'string' ? data.description : '',
    command: typeof data.command === 'string' ? data.command : '',
    args: Array.isArray(data.args) ? data.args.map(String) : [],
    env_template:
      data.env_template && typeof data.env_template === 'object' && !Array.isArray(data.env_template)
        ? Object.fromEntries(
            Object.entries(data.env_template as Record<string, unknown>).map(
              ([k, v]) => [k, String(v)],
            ),
          )
        : {},
    inputs,
    coming_soon: !!data.coming_soon,
  }
}

export function listPresets(): Preset[] {
  const root = presetsRoot()
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: Preset[] = []
  const files = fs
    .readdirSync(root)
    .filter((n) => n.endsWith('.yaml'))
    .sort()
  for (const name of files) {
    const preset = loadOne(path.join(root, name))
    if (preset) out.push(preset)
  }
  return out
}

export function getPreset(presetId: string): Preset | null {
  return listPresets().find((p) => p.id === presetId) ?? null
}

export function materialise(
  preset: Preset,
  inputs: Record<string, string>,
): ServerConfig {
  const sub = (s: string): string =>
    s.replace(PLACEHOLDER, (_m, key: string) => String(inputs[key] ?? ''))
  return {
    command: preset.command,
    args: preset.args.map(sub),
    env: Object.fromEntries(
      Object.entries(preset.env_template).map(([k, v]) => [k, sub(v)]),
    ),
    preset_id: preset.id,
  }
}
