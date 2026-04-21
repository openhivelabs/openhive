import type { NextConfig } from 'next'

// As of the python→ts migration completion, /api/* is served entirely by
// apps/web/app/api/** route handlers. No proxy fallback, no second process.
const config: NextConfig = {
  images: { unoptimized: true },
}

export default config
