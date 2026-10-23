// Runs Vitest inside Electron's bundled Node so storage tests load the same
// runtime and native driver build that the app uses.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const result = spawnSync(electron, [vitest, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(result.status ?? 1)
