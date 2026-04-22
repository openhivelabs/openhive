import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 4484}` },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
