import { listGallery } from '@/lib/server/frames'
import { Hono } from 'hono'

export const frames = new Hono()

// GET /api/frames/gallery
frames.get('/gallery', (c) => c.json(listGallery()))
