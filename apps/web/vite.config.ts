import { readFileSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Single source of truth: package.json#version. Injected at build time so the
// AboutSection (and anywhere else) can render `__APP_VERSION__` without us
// touching another file every release.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    // `/callback` + `/auth/callback` are the OAuth redirect landing paths
    // that Anthropic / OpenAI's shared CLI client_ids expect. In prod hono
    // serves them directly; in dev we forward them through vite so the
    // post-auth redirect lands on hono's callback handler (which exchanges
    // the code for tokens and shows a self-closing success page).
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT ?? 4484}`,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            const ct = String(proxyRes.headers['content-type'] ?? '')
            if (!ct.startsWith('text/event-stream')) return
            res.setHeader('X-Accel-Buffering', 'no')
            res.setHeader('Cache-Control', 'no-cache, no-transform')
            // Take ownership of the body pipe so each SSE frame is flushed
            // immediately instead of being coalesced by http-proxy's default
            // buffering. http-proxy still owns close/end semantics.
            proxyRes.on('data', (chunk: Buffer) => {
              res.write(chunk)
            })
          })
        },
      },
      '/callback': `http://localhost:${process.env.API_PORT ?? 4484}`,
      '/auth/callback': `http://localhost:${process.env.API_PORT ?? 4484}`,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
