import { describe, expect, it } from 'vitest'
import { panelTools } from './panel-tools'

describe('panelTools — surface', () => {
  const tools = panelTools('acme', 'main', 't-1')

  it('registers all 13 tools with the right names', () => {
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'panel_list',
        'panel_get',
        'panel_market_list',
        'panel_install',
        'panel_update_binding',
        'panel_set_position',
        'panel_set_props',
        'panel_delete',
        'panel_refresh',
        'panel_get_data',
        'panel_execute_action',
        'dashboard_list_backups',
        'dashboard_restore_backup',
      ].sort(),
    )
  })

  it('every tool carries a category for system-prompt narrative', () => {
    for (const t of tools) {
      expect(t.category, `tool ${t.name} missing category`).toBeTruthy()
      expect(['panel', 'dashboard']).toContain(t.category)
    }
  })

  it('panel_* tools use panel category, dashboard_* tools use dashboard', () => {
    for (const t of tools) {
      if (t.name.startsWith('panel_')) expect(t.category).toBe('panel')
      else if (t.name.startsWith('dashboard_')) expect(t.category).toBe('dashboard')
    }
  })

  it('every tool exposes a description and parameters schema', () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.parameters).toBeTruthy()
      expect((t.parameters as { type?: unknown }).type).toBe('object')
    }
  })
})

describe('panelTools — destructive gates', () => {
  const tools = panelTools('acme', 'main', 't-1')

  it('panel_delete denies without confirm: true', async () => {
    const tool = tools.find((t) => t.name === 'panel_delete')!
    const raw = (await tool.handler({ panel_id: 'p-x' })) as string
    const out = JSON.parse(raw)
    expect(out.ok).toBe(false)
    expect(out.error_code).toBe('destructive_unconfirmed')
    expect(String(out.suggestion)).toMatch(/confirm/i)
  })

  it('panel_delete denies when confirm is falsy', async () => {
    const tool = tools.find((t) => t.name === 'panel_delete')!
    const raw = (await tool.handler({ panel_id: 'p-x', confirm: false })) as string
    const out = JSON.parse(raw)
    expect(out.error_code).toBe('destructive_unconfirmed')
  })

  it('dashboard_restore_backup denies without confirm: true', async () => {
    const tool = tools.find((t) => t.name === 'dashboard_restore_backup')!
    const raw = (await tool.handler({ name: 'whatever.v2026' })) as string
    const out = JSON.parse(raw)
    expect(out.ok).toBe(false)
    expect(out.error_code).toBe('destructive_unconfirmed')
  })
})

describe('panelTools — invalid args', () => {
  const tools = panelTools('acme', 'main', 't-1')

  it('panel_install rejects missing frame_id/category', async () => {
    const tool = tools.find((t) => t.name === 'panel_install')!
    const raw = (await tool.handler({})) as string
    const out = JSON.parse(raw)
    expect(out.error_code).toBe('invalid_args')
  })

  it('panel_update_binding rejects missing user_intent', async () => {
    const tool = tools.find((t) => t.name === 'panel_update_binding')!
    const raw = (await tool.handler({ panel_id: 'p-x' })) as string
    const out = JSON.parse(raw)
    expect(out.error_code).toBe('invalid_args')
  })

  it('panel_update_binding rejects whitespace-only user_intent', async () => {
    const tool = tools.find((t) => t.name === 'panel_update_binding')!
    const raw = (await tool.handler({ panel_id: 'p-x', user_intent: '   ' })) as string
    const out = JSON.parse(raw)
    expect(out.error_code).toBe('invalid_args')
  })
})

describe('panelTools — install workflow guidance', () => {
  const tools = panelTools('acme', 'main', 't-1')

  it('panel_install description tells the LLM to follow up with panel_update_binding', () => {
    const tool = tools.find((t) => t.name === 'panel_install')!
    expect(tool.description).toMatch(/panel_update_binding/)
  })
})
