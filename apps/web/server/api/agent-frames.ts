import { listAgentGallery } from '@/lib/server/agent-frames'
import { Hono } from 'hono'

export const agentFrames = new Hono()

// GET /api/agent-frames/gallery
agentFrames.get('/gallery', (c) => c.json(listAgentGallery()))
