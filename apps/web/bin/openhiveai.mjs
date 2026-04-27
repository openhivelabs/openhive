#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import path from 'node:path'

process.env.NODE_ENV ??= 'production'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.resolve(here, '..', 'dist-server', 'server', 'index.js')

await import(entry)
