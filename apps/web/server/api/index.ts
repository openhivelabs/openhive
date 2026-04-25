import { Hono } from 'hono'
import { agentFrames } from './agent-frames'
import { agents } from './agents'
import { ai } from './ai'
import { artifacts } from './artifacts'
import { backup } from './backup'
import { companies } from './companies'
import { credentials } from './credentials'
import { frames } from './frames'
import { health } from './health'
import { market } from './market'
import { mcp } from './mcp'
import { panels } from './panels'
import { providers } from './providers'
import { sessions } from './sessions'
import { tasks } from './tasks'
import { teams } from './teams'
import { usage } from './usage'

export const api = new Hono()
api.route('/health', health)
api.route('/companies', companies)
api.route('/credentials', credentials)
api.route('/agents', agents)
api.route('/agent-frames', agentFrames)
api.route('/ai', ai)
api.route('/artifacts', artifacts)
api.route('/backup', backup)
api.route('/frames', frames)
api.route('/market', market)
api.route('/mcp', mcp)
api.route('/panels', panels)
api.route('/providers', providers)
api.route('/sessions', sessions)
api.route('/tasks', tasks)
api.route('/teams', teams)
api.route('/usage', usage)
