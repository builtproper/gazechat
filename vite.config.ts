import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// g2-logger: the glasses app POSTs console output to /__log -> g2.log
// (same pattern as the KM app; freshly truncated on every dev-server start).
function g2Logger() {
  return {
    name: 'g2-logger',
    configureServer(server: any) {
      const logPath = path.resolve(process.cwd(), 'g2.log')
      fs.writeFileSync(logPath, `=== session ${new Date().toISOString()} ===\n`)
      server.middlewares.use('/__log', (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          fs.appendFile(logPath, body + '\n', () => {})
          res.statusCode = 204
          res.end()
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), g2Logger()],
  server: {
    host: true,
    port: 5173,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
