// Command-line entry of the usage-statistics service. Runs on plain Node.js 24 without
// a build step or runtime dependencies; see docs/analytics-service.md.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdminAuthenticator, hashPassword, parsePasswordHash } from './auth.ts'
import { statDayAt } from './days.ts'
import { createAnalyticsService } from './http.ts'
import type { DashboardAsset } from './http.ts'
import { openAnalyticsStore, parseSummaryBackup } from './store.ts'

const USAGE = `usage: node server/analytics/main.ts <command>

  serve            apply retention, then serve the API and dashboard
  cleanup          apply retention to the database once
  backup <file>    write anonymous per-day counts (no instance data) to <file>
  restore <file>   create a new database from a backup, then apply retention
  hash-password    read the dashboard password from stdin and print its hash

environment:
  XIDAO_ANALYTICS_DB                    database path (all commands except hash-password)
  XIDAO_ANALYTICS_ADMIN_PASSWORD_HASH   output of hash-password (serve)
  XIDAO_ANALYTICS_ADMIN_USER            dashboard user name, default "admin" (serve)
  XIDAO_ANALYTICS_HOST                  listen address, default 127.0.0.1 (serve)
  XIDAO_ANALYTICS_PORT                  listen port, default 8787 (serve)
  XIDAO_ANALYTICS_MAX_INSTANCES         registered-instance cap, default 100000 (serve)`

const MIN_PASSWORD_LENGTH = 12

function log(event: string, fields: Record<string, string | number> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return value
}

function loadDashboard(): Map<string, DashboardAsset> {
  const directory = join(dirname(fileURLToPath(import.meta.url)), 'dashboard')
  const files: Array<[string, string, string]> = [
    ['/admin/', 'index.html', 'text/html; charset=utf-8'],
    ['/admin/dashboard.js', 'dashboard.js', 'text/javascript; charset=utf-8'],
    ['/admin/dashboard.css', 'dashboard.css', 'text/css; charset=utf-8']
  ]
  return new Map(files.map(([path, file, contentType]) => [path, { contentType, body: readFileSync(join(directory, file)) }]))
}

async function serve(): Promise<void> {
  const passwordHash = parsePasswordHash(requiredEnv('XIDAO_ANALYTICS_ADMIN_PASSWORD_HASH'))
  const username = process.env.XIDAO_ANALYTICS_ADMIN_USER?.trim() || 'admin'
  const host = process.env.XIDAO_ANALYTICS_HOST?.trim() || '127.0.0.1'
  const port = integerEnv('XIDAO_ANALYTICS_PORT', 8787, 1, 65535)
  const maxInstances = integerEnv('XIDAO_ANALYTICS_MAX_INSTANCES', 100_000, 1, 10_000_000)
  const dashboard = loadDashboard()
  const store = openAnalyticsStore({ path: requiredEnv('XIDAO_ANALYTICS_DB') })
  const service = createAnalyticsService({
    store,
    admin: createAdminAuthenticator({ username, passwordHash, clock: Date.now }),
    clock: Date.now,
    log,
    dashboard,
    maxInstances
  })
  // Retention runs before the first request is accepted, including after a restore.
  service.maintain()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  service.server.once('error', reject)
  service.server.listen(port, host, () => resolve())
  await promise
  log('listening', { host, port })

  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void service.close().then(() => {
      store.close()
      log('stopped')
    })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

function cleanup(): void {
  const store = openAnalyticsStore({ path: requiredEnv('XIDAO_ANALYTICS_DB') })
  try {
    log('retention_applied', { day: statDayAt(Date.now()), ...store.cleanup(statDayAt(Date.now())) })
  } finally {
    store.close()
  }
}

function backup(target: string | undefined): void {
  if (!target) throw new Error('backup needs a target file')
  const store = openAnalyticsStore({ path: requiredEnv('XIDAO_ANALYTICS_DB') })
  try {
    const document = store.exportSummaries(statDayAt(Date.now()))
    const temporary = `${target}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, target)
    log('backup_written', { days: document.days.length })
  } finally {
    store.close()
  }
}

function restore(source: string | undefined): void {
  if (!source) throw new Error('restore needs a backup file')
  const backupDocument = parseSummaryBackup(JSON.parse(readFileSync(source, 'utf8')))
  const today = statDayAt(Date.now())
  const store = openAnalyticsStore({ path: requiredEnv('XIDAO_ANALYTICS_DB'), createOnly: true })
  try {
    const imported = store.importSummaries(backupDocument, today)
    log('restored', { days: imported })
    log('retention_applied', { day: today, ...store.cleanup(today) })
  } finally {
    store.close()
  }
}

async function printPasswordHash(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk)
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if ([...password].length < MIN_PASSWORD_LENGTH) throw new Error(`password must have at least ${MIN_PASSWORD_LENGTH} characters`)
  process.stdout.write(`${await hashPassword(password)}\n`)
}

async function main(argv: string[]): Promise<void> {
  const [command, argument] = argv
  switch (command) {
    case 'serve': return serve()
    case 'cleanup': return cleanup()
    case 'backup': return backup(argument)
    case 'restore': return restore(argument)
    case 'hash-password': return printPasswordHash()
    default:
      process.stderr.write(`${USAGE}\n`)
      process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
