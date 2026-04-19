import type { NextConfig } from 'next'

const isDev = process.env.NODE_ENV !== 'production'

const config: NextConfig = {
  // Static export only for production. In dev we need a Node server to proxy /api.
  ...(isDev ? {} : { output: 'export' as const }),
  images: { unoptimized: true },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: 'http://127.0.0.1:4484/api/:path*' },
    ]
  },
}

export default config
