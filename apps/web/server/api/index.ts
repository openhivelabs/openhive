import { Hono } from 'hono'
import { companies } from './companies'
import { health } from './health'

export const api = new Hono()
api.route('/health', health)
api.route('/companies', companies)
