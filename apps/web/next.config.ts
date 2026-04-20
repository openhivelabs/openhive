import type { NextConfig } from 'next'

const isDev = process.env.NODE_ENV !== 'production'

const config: NextConfig = {
  // Static export only for production. In dev we need a Node server to proxy /api.
  ...(isDev ? {} : { output: 'export' as const }),
  images: { unoptimized: true },
  async rewrites() {
    // `fallback` runs AFTER Next.js has checked every filesystem route
    // (including dynamic ones). Guarantees TS route handlers under
    // `apps/web/app/api/**` always win; anything unmigrated still falls
    // through to the legacy FastAPI server on :4484.
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        { source: '/api/:path*', destination: 'http://127.0.0.1:4484/api/:path*' },
      ],
    }
  },
}

export default config
