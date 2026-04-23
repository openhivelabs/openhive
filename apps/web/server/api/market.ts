import { Hono } from 'hono'
import { listConnected } from '@/lib/server/tokens'
import { installAgentFrame } from '@/lib/server/agent-frames'
import { installFrame } from '@/lib/server/frames'
import {
  type MarketType,
  fetchMarketFrame,
  fetchMarketIndex,
} from '@/lib/server/market'

export const market = new Hono()

// GET /api/market — remote catalog (companies / teams / agents + warnings)
market.get('/', async (c) => c.json(await fetchMarketIndex()))

interface InstallBody {
  type?: MarketType
  id?: string
  target_company_slug?: string
  target_team_slug?: string
}

// POST /api/market/install — fetch a single remote frame and install it via
// the existing local installers. Team/agent go through their usual install
// paths; `company` is a bundle of team frame ids that must target an
// existing company.
market.post('/install', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as InstallBody
  const type = body.type
  const id = body.id
  if (!type || !id) {
    return c.json({ detail: 'type and id required' }, 400)
  }
  if (type === 'team') {
    const targetCompany = body.target_company_slug
    if (!targetCompany) {
      return c.json({ detail: 'target_company_slug required for team' }, 400)
    }
    try {
      const frame = await fetchMarketFrame('team', id)
      const result = installFrame(targetCompany, frame, {
        connectedProviders: new Set(listConnected()),
      })
      return c.json({ type, id, ...result })
    } catch (err) {
      const code = (err as { code?: string }).code
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ detail: message }, code === 'ENOENT' ? 404 : 400)
    }
  }
  if (type === 'agent') {
    const targetCompany = body.target_company_slug
    const targetTeam = body.target_team_slug
    if (!targetCompany || !targetTeam) {
      return c.json(
        { detail: 'target_company_slug and target_team_slug required for agent' },
        400,
      )
    }
    try {
      const frame = await fetchMarketFrame('agent', id)
      const result = installAgentFrame(targetCompany, targetTeam, frame)
      return c.json({ type, id, ...result })
    } catch (err) {
      const code = (err as { code?: string }).code
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ detail: message }, code === 'ENOENT' ? 404 : 400)
    }
  }
  if (type === 'company') {
    return c.json(
      {
        detail:
          'company-frame install not implemented yet — unpack the bundle manifest client-side and install each team frame into a new company.',
      },
      501,
    )
  }
  return c.json({ detail: `unknown type: ${String(type)}` }, 400)
})
