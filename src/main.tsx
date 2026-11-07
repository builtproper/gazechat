import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/variables.css'

// g2-logger: forward console to the dev server (/__log -> g2.log) so Jarvis
// can read glasses-side logs directly. Dev-only endpoint; fails silently.
const _log = console.log.bind(console)
const _warn = console.warn.bind(console)
const _err = console.error.bind(console)
function ship(level: string, args: unknown[]) {
  try {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${level} ${args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}`
    fetch('/__log', { method: 'POST', body: line }).catch(() => {})
  } catch {}
}
// Only in `vite dev`: the /__log endpoint exists only on the dev server, and in a packaged
// build the forwarder would POST every console line (message text included) to the app origin.
if (import.meta.env.DEV) {
  console.log = (...a: unknown[]) => { _log(...a); ship('log', a) }
  console.warn = (...a: unknown[]) => { _warn(...a); ship('warn', a) }
  console.error = (...a: unknown[]) => { _err(...a); ship('err', a) }
}

// Global error handler for development
window.addEventListener('error', (event) => {
  console.error('[GazeChat] Error:', event.error)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[GazeChat] Unhandled rejection:', event.reason)
})

const root = document.getElementById('root')

if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  )
}
