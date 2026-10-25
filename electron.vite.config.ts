import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer is local app UI only: no remote scripts, frames or objects.
// Dev needs inline scripts/styles and a websocket for HMR; production does not.
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: xidao-image:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'"
].join('; ')

const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: xidao-image:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'"
].join('; ')

function contentSecurityPolicy(): Plugin {
  let csp = PRODUCTION_CSP
  return {
    name: 'xidao:csp',
    configResolved(config) {
      csp = config.command === 'serve' ? DEV_CSP : PRODUCTION_CSP
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: {
    define: { 'process.env.VITE_XIDAO_PROTOTYPE': JSON.stringify(process.env.VITE_XIDAO_PROTOTYPE ?? '') },
    build: {
      externalizeDeps: true
    }
  },
  preload: {
    build: {
      // Sandboxed preloads must be a single CommonJS script without Node module access.
      externalizeDeps: false,
      rolldownOptions: {
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    plugins: [react(), contentSecurityPolicy()]
  }
})
