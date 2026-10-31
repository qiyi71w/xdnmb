import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ANALYTICS_PATHS } from '../src/shared/analytics-protocol.ts'
import type { AnalyticsCredentials } from '../src/shared/analytics-protocol.ts'
import { createAdminAuthenticator, hashPassword, parsePasswordHash } from '../server/analytics/auth.ts'
import type { PasswordHash } from '../server/analytics/auth.ts'
import { addDays, summaryCutoff } from '../server/analytics/days.ts'
import { createAnalyticsService, DEFAULT_RATE_LIMITS } from '../server/analytics/http.ts'
import type { AdminSummaryResponse, AnalyticsService, RateLimits } from '../server/analytics/http.ts'
import { openAnalyticsStore, parseSummaryBackup } from '../server/analytics/store.ts'
import type { AnalyticsStore } from '../server/analytics/store.ts'

const ADMIN_PASSWORD = 'tide-pool-reading-room'
let passwordHash: PasswordHash
let now = 0
const directories: string[] = []
const running: Array<{ service: AnalyticsService; store: AnalyticsStore }> = []

beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword(ADMIN_PASSWORD))
})

afterEach(async () => {
  for (const { service, store } of running.splice(0)) {
    await service.close()
    store.close()
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Noon (or the given time) in Beijing on `day`. */
function setBeijing(day: string, time = '12:00:00'): void {
  now = Date.parse(`${day}T${time}+08:00`)
}

function tempDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'xidao-analytics-'))
  directories.push(directory)
  return join(directory, 'analytics.sqlite')
}

interface Harness {
  base: string
  path: string
  logs: string[]
  store: AnalyticsStore
  service: AnalyticsService
}

async function start(path: string, options: { limits?: RateLimits; maxInstances?: number; logs?: string[] } = {}): Promise<Harness> {
  const store = openAnalyticsStore({ path })
  const logs = options.logs ?? []
  const service = createAnalyticsService({
    store,
    admin: createAdminAuthenticator({ username: 'admin', passwordHash, clock: () => now }),
    clock: () => now,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    dashboard: new Map([['/admin/', { contentType: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><title>dashboard</title>') }]]),
    maxInstances: options.maxInstances ?? 1000,
    limits: options.limits ?? { ...DEFAULT_RATE_LIMITS, selfOperations: { capacity: 10_000, perMinute: 10_000 }, register: { capacity: 1000, perMinute: 1000 } }
  })
  service.maintain()
  running.push({ service, store })
  const { promise, resolve } = Promise.withResolvers<void>()
  service.server.listen(0, '127.0.0.1', () => resolve())
  await promise
  const address = service.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { base: `http://127.0.0.1:${address.port}`, path, logs, store, service }
}

async function stop(harness: Harness): Promise<void> {
  const index = running.findIndex((entry) => entry.service === harness.service)
  running.splice(index, 1)
  await harness.service.close()
  harness.store.close()
}

async function post(harness: Harness, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(harness.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) as Record<string, unknown> | null }
}

async function register(harness: Harness): Promise<AnalyticsCredentials> {
  const response = await post(harness, ANALYTICS_PATHS.register, { protocol: 1 })
  expect(response.status).toBe(201)
  return response.body as unknown as AnalyticsCredentials
}

function report(harness: Harness, credentials: AnalyticsCredentials, version = '1.0.0', platform = 'windows') {
  return post(harness, ANALYTICS_PATHS.activity, { protocol: 1, ...credentials, version, platform })
}

function remove(harness: Harness, credentials: AnalyticsCredentials) {
  return post(harness, ANALYTICS_PATHS.deletion, { protocol: 1, ...credentials })
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

async function summary(harness: Harness): Promise<AdminSummaryResponse> {
  const response = await fetch(`${harness.base}/admin/api/summary`, { headers: { Authorization: basic('admin', ADMIN_PASSWORD) } })
  expect(response.status).toBe(200)
  return await response.json() as AdminSummaryResponse
}

function trendDay(result: AdminSummaryResponse, day: string) {
  return result.trend.days.find((entry) => entry.day === day)
}

function rows(path: string, sql: string, ...params: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

describe('analytics service counting', () => {
  it('counts only reported instances once per Beijing day, including concurrent repeats', async () => {
    setBeijing('2026-10-31')
    const harness = await start(tempDatabase())
    const [a, b, registeredOnly] = [await register(harness), await register(harness), await register(harness)]
    expect(registeredOnly.instanceId).not.toBe(a.instanceId)

    const empty = await summary(harness)
    expect(empty.todayActive).toBe(0)
    expect(trendDay(empty, '2026-10-31')).toEqual({ day: '2026-10-31', active: 0, source: 'detail' })

    expect((await report(harness, a)).body).toEqual({ statDay: '2026-10-31', duplicate: false })
    const repeats = await Promise.all([...Array(5)].flatMap(() => [report(harness, a), report(harness, b, '1.0.0', 'macos')]))
    expect(repeats.every((response) => response.status === 200)).toBe(true)
    expect(repeats.filter((response) => response.body?.duplicate === false)).toHaveLength(1)

    const counted = await summary(harness)
    expect(counted.todayActive).toBe(2)
    expect(counted.window.active).toBe(2)
    expect(counted.distributions.today.platforms).toEqual([{ value: 'macos', count: 1 }, { value: 'windows', count: 1 }])

    // The day is assigned by the server clock at the Beijing midnight boundary.
    setBeijing('2026-10-31', '23:59:59')
    expect((await report(harness, a)).body).toEqual({ statDay: '2026-10-31', duplicate: true })
    setBeijing('2026-11-01', '00:00:00')
    expect((await report(harness, a)).body).toEqual({ statDay: '2026-11-01', duplicate: false })
    const nextDay = await summary(harness)
    expect(nextDay.todayActive).toBe(1)
    expect(nextDay.window.active).toBe(2)
    expect(trendDay(nextDay, '2026-10-31')?.active).toBe(2)
  })

  it('applies the 30-day window and attributes versions to the last report in each window', async () => {
    setBeijing('2026-10-01')
    const harness = await start(tempDatabase())
    const a = await register(harness)
    const b = await register(harness)
    await report(harness, a, '1.0.0', 'windows')
    await report(harness, b, '1.0.0', 'macos')

    setBeijing('2026-10-30') // 30th day of the window that starts on 10-01
    await report(harness, a, '1.1.0', 'windows')
    const day30 = await summary(harness)
    expect(day30.window).toMatchObject({ from: '2026-10-01', to: '2026-10-30', active: 2 })
    expect(day30.distributions.window.versions).toEqual([{ value: '1.0.0', count: 1 }, { value: '1.1.0', count: 1 }])
    expect(day30.distributions.today.versions).toEqual([{ value: '1.1.0', count: 1 }])
    expect(trendDay(day30, '2026-10-15')).toEqual({ day: '2026-10-15', active: null, source: 'missing' })
    expect(day30.window.missingDays).toBe(28)

    setBeijing('2026-10-31') // 10-01 is now the 31st day: outside the active window, still retained
    const day31 = await summary(harness)
    expect(day31.window).toMatchObject({ from: '2026-10-02', active: 1 })
    expect(day31.distributions.window.platforms).toEqual([{ value: 'windows', count: 1 }])
    expect(trendDay(day31, '2026-10-01')).toEqual({ day: '2026-10-01', active: 2, source: 'detail' })
  })
})

describe('analytics service deletion', () => {
  it('rejects foreign credentials, deletes idempotently and keeps older anonymous summaries', async () => {
    setBeijing('2026-09-01')
    const harness = await start(tempDatabase())
    const a = await register(harness)
    const b = await register(harness)
    await report(harness, a)
    await report(harness, b)
    setBeijing('2026-09-02')
    await report(harness, a)
    await report(harness, b)
    setBeijing('2026-10-02') // 09-01 left the 31-day detail window and is frozen
    await report(harness, a)
    await report(harness, b)

    const foreign = await remove(harness, { instanceId: a.instanceId, token: b.token })
    expect(foreign).toMatchObject({ status: 403, body: { error: 'invalid_credentials' } })
    expect((await summary(harness)).todayActive).toBe(2)

    expect(await remove(harness, a)).toMatchObject({ status: 200, body: { deleted: true } })
    expect(await remove(harness, a)).toMatchObject({ status: 200, body: { deleted: true } })
    expect(await report(harness, a)).toMatchObject({ status: 403, body: { error: 'invalid_credentials' } })

    const after = await summary(harness)
    expect(after.todayActive).toBe(1)
    expect(trendDay(after, '2026-09-02')).toEqual({ day: '2026-09-02', active: 1, source: 'detail' })
    expect(trendDay(after, '2026-09-01')).toEqual({ day: '2026-09-01', active: 2, source: 'summary' })
    expect(rows(harness.path, 'SELECT * FROM daily_activity WHERE instance_id = ?', a.instanceId)).toEqual([])
    expect(rows(harness.path, 'SELECT * FROM instances WHERE id = ?', a.instanceId)).toEqual([])
  })

  it('never revives an instance when late reports race its deletion, also after reopening', async () => {
    setBeijing('2026-10-31')
    const path = tempDatabase()
    const harness = await start(path)
    const a = await register(harness)
    const b = await register(harness)
    await report(harness, b)

    const raced = await Promise.all([
      report(harness, a), report(harness, a), remove(harness, a), report(harness, a), report(harness, a), remove(harness, a), report(harness, a)
    ])
    expect(raced.filter((response) => response.status === 200 && 'deleted' in (response.body ?? {}))).toHaveLength(2)
    expect((await summary(harness)).todayActive).toBe(1)

    await stop(harness)
    const reopened = await start(path)
    expect(await report(reopened, a)).toMatchObject({ status: 403 })
    expect((await summary(reopened)).todayActive).toBe(1)
    await stop(reopened)
    // Deleted identifiers do not linger in the database or its WAL.
    const files = readdirSync(join(path, '..')).map((name) => readFileSync(join(path, '..', name)))
    expect(files.some((bytes) => bytes.includes(a.instanceId))).toBe(false)
  })

  it('rolls back an interrupted deletion and completes it on retry after a restart', async () => {
    setBeijing('2026-10-31')
    const path = tempDatabase()
    const harness = await start(path)
    const a = await register(harness)
    await report(harness, a)

    const control = new DatabaseSync(path)
    control.exec("CREATE TRIGGER interrupt BEFORE DELETE ON instances BEGIN SELECT RAISE(ABORT, 'interrupted'); END")
    expect(await remove(harness, a)).toMatchObject({ status: 500, body: { error: 'server_error' } })
    expect((await summary(harness)).todayActive).toBe(1)
    expect((await report(harness, a)).body).toEqual({ statDay: '2026-10-31', duplicate: true })
    control.exec('DROP TRIGGER interrupt')
    control.close()

    await stop(harness)
    const reopened = await start(path)
    expect(await remove(reopened, a)).toMatchObject({ status: 200 })
    expect((await summary(reopened)).todayActive).toBe(0)
  })
})

describe('analytics service retention', () => {
  it('keeps active identities stable and removes idle identities and their records after 31 days', async () => {
    setBeijing('2026-01-01')
    const path = tempDatabase()
    const harness = await start(path)
    const steady = await register(harness)
    const idle = await register(harness)
    const neverActive = await register(harness)
    await report(harness, idle)

    for (let day = 1; day <= 40; day += 1) {
      setBeijing(addDays('2026-01-01', day - 1))
      expect((await report(harness, steady)).status).toBe(200)
      if (day === 31) {
        // 2026-01-31 is the 31st statistics day since the idle activity: still retained.
        expect(rows(path, 'SELECT count(*) AS n FROM instances')[0]?.n).toBe(3)
        expect(rows(path, "SELECT count(*) AS n FROM daily_activity WHERE day = '2026-01-01'")[0]?.n).toBe(2)
      }
      if (day === 32) {
        expect(rows(path, 'SELECT count(*) AS n FROM instances')[0]?.n).toBe(1)
        expect(rows(path, "SELECT count(*) AS n FROM daily_activity WHERE day = '2026-01-01'")[0]?.n).toBe(0)
      }
    }
    expect(await report(harness, idle)).toMatchObject({ status: 403 })
    expect(await report(harness, neverActive)).toMatchObject({ status: 403 })
    const result = await summary(harness)
    expect(result.window.active).toBe(1)
    expect(trendDay(result, '2026-01-01')).toEqual({ day: '2026-01-01', active: 2, source: 'summary' })
  })

  it('drops anonymous summaries after 12 months', async () => {
    setBeijing('2025-10-31')
    const path = tempDatabase()
    const harness = await start(path)
    await report(harness, await register(harness))
    setBeijing('2026-10-31')
    expect(trendDay(await summary(harness), '2025-10-31')).toEqual({ day: '2025-10-31', active: 1, source: 'summary' })
    setBeijing('2026-11-01')
    const result = await summary(harness)
    expect(result.trend.from).toBe('2025-11-01')
    expect(rows(path, "SELECT * FROM service_days WHERE day = '2025-10-31'")).toEqual([])
    expect(summaryCutoff('2024-02-29')).toBe('2023-02-28')
  })

  it('retries cleanup after a failed run without blocking requests', async () => {
    setBeijing('2026-10-01')
    const path = tempDatabase()
    const harness = await start(path)
    await report(harness, await register(harness))
    const control = new DatabaseSync(path)
    control.exec("CREATE TRIGGER interrupt BEFORE DELETE ON daily_activity BEGIN SELECT RAISE(ABORT, 'interrupted'); END")

    setBeijing('2026-11-01')
    expect((await summary(harness)).todayActive).toBe(0)
    expect(harness.logs.some((line) => line.includes('"area":"maintenance"'))).toBe(true)
    expect(rows(path, "SELECT frozen_active FROM service_days WHERE day = '2026-10-01'")).toEqual([{ frozen_active: null }])

    control.exec('DROP TRIGGER interrupt')
    control.close()
    await summary(harness)
    expect(rows(path, 'SELECT count(*) AS n FROM daily_activity')[0]?.n).toBe(0)
    expect(rows(path, "SELECT frozen_active FROM service_days WHERE day = '2026-10-01'")).toEqual([{ frozen_active: 1 }])
  })

  it('restores only anonymous day counts and refuses to overwrite a database', async () => {
    setBeijing('2026-10-01')
    const path = tempDatabase()
    const harness = await start(path)
    const a = await register(harness)
    const b = await register(harness)
    await report(harness, a)
    await report(harness, b)
    setBeijing('2026-10-02')
    await report(harness, a)
    await remove(harness, b)
    setBeijing('2026-10-03')
    await summary(harness)

    const backup = parseSummaryBackup(JSON.parse(JSON.stringify(harness.store.exportSummaries('2026-10-03'))))
    expect(backup.days).toEqual([{ day: '2026-10-01', active: 1 }, { day: '2026-10-02', active: 1 }])
    const serialized = JSON.stringify(backup)
    expect(serialized.includes(a.instanceId) || serialized.includes(b.instanceId)).toBe(false)
    expect(() => openAnalyticsStore({ path, createOnly: true })).toThrow(/refusing to overwrite/)

    const restoredPath = tempDatabase()
    const restoredStore = openAnalyticsStore({ path: restoredPath, createOnly: true })
    restoredStore.importSummaries({ ...backup, days: [{ day: '2025-09-30', active: 9 }, ...backup.days] }, '2026-10-03')
    restoredStore.close()
    const restored = await start(restoredPath)
    expect(await report(restored, b)).toMatchObject({ status: 403 })
    expect(await report(restored, a)).toMatchObject({ status: 403 })
    const result = await summary(restored)
    expect(trendDay(result, '2026-10-01')).toEqual({ day: '2026-10-01', active: 1, source: 'summary' })
    expect(result.window.summaryOnlyDays).toBe(2)
    expect(rows(restoredPath, "SELECT * FROM service_days WHERE day = '2025-09-30'")).toEqual([])
  })
})

describe('analytics service boundaries', () => {
  it('accepts only the protocol fields and never registers unknown identities implicitly', async () => {
    setBeijing('2026-10-31')
    const path = tempDatabase()
    const harness = await start(path)
    const a = await register(harness)
    const valid = { protocol: 1, ...a, version: '1.0.0', platform: 'windows' }

    expect(await post(harness, ANALYTICS_PATHS.activity, { ...valid, arch: 'x64' })).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    expect(await post(harness, ANALYTICS_PATHS.activity, { ...valid, day: '2026-10-01' })).toMatchObject({ status: 400 })
    expect(await post(harness, ANALYTICS_PATHS.activity, { ...valid, protocol: 2 })).toMatchObject({ status: 400, body: { error: 'unsupported_protocol' } })
    expect(await post(harness, ANALYTICS_PATHS.activity, { ...valid, platform: 'linux' })).toMatchObject({ status: 400 })
    expect(await post(harness, ANALYTICS_PATHS.activity, { ...valid, version: 'v1' })).toMatchObject({ status: 400 })
    expect(await post(harness, ANALYTICS_PATHS.activity, { ...valid, version: 1 })).toMatchObject({ status: 400 })
    expect(await post(harness, ANALYTICS_PATHS.activity, '{"protocol":1,')).toMatchObject({ status: 400 })
    expect(await post(harness, ANALYTICS_PATHS.activity, valid, { 'Content-Type': 'text/plain' })).toMatchObject({ status: 415 })
    expect(await post(harness, ANALYTICS_PATHS.activity, { ...valid, version: `1.0.0-${'a'.repeat(1100)}` })).toMatchObject({ status: 413, body: { error: 'payload_too_large' } })
    expect((await fetch(harness.base + ANALYTICS_PATHS.activity)).status).toBe(405)
    expect((await fetch(`${harness.base}/v1/summary`)).status).toBe(404)

    const stranger = { instanceId: 'A'.repeat(22), token: 'B'.repeat(43) }
    expect(await report(harness, stranger)).toMatchObject({ status: 403, body: { error: 'invalid_credentials' } })
    expect(await remove(harness, stranger)).toMatchObject({ status: 200 })
    expect(rows(path, 'SELECT count(*) AS n FROM instances')[0]?.n).toBe(1)
    expect((await summary(harness)).todayActive).toBe(0)
  })

  it('throttles with Retry-After and caps registrations', async () => {
    setBeijing('2026-10-31')
    const harness = await start(tempDatabase(), {
      limits: { ...DEFAULT_RATE_LIMITS, register: { capacity: 2, perMinute: 2 } },
      maxInstances: 3
    })
    await register(harness)
    await register(harness)
    const limited = await post(harness, ANALYTICS_PATHS.register, { protocol: 1 })
    expect(limited).toMatchObject({ status: 429, body: { error: 'rate_limited' } })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    now += 60_000
    await register(harness)
    expect(await post(harness, ANALYTICS_PATHS.register, { protocol: 1 })).toMatchObject({ status: 503, body: { error: 'capacity_exhausted' } })
  })

  it('protects every dashboard path and keeps report credentials out of admin access', async () => {
    setBeijing('2026-10-31')
    const harness = await start(tempDatabase(), {
      // The forged report credentials below count as the first failed guess.
      limits: { ...DEFAULT_RATE_LIMITS, adminFailures: { capacity: 3, perMinute: 1 } }
    })
    const a = await register(harness)
    for (const path of ['/admin', '/admin/', '/admin/api/summary', '/admin/missing']) {
      const response = await fetch(harness.base + path)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toMatch(/^Basic /)
    }
    const asReporter = await fetch(`${harness.base}/admin/api/summary`, { headers: { Authorization: basic(a.instanceId, a.token) } })
    expect(asReporter.status).toBe(401)
    const bearer = await fetch(`${harness.base}/admin/api/summary`, { headers: { Authorization: `Bearer ${a.token}` } })
    expect(bearer.status).toBe(401)

    const page = await fetch(`${harness.base}/admin/`, { headers: { Authorization: basic('admin', ADMIN_PASSWORD) } })
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")

    // Failed guesses are throttled; an already verified session keeps working.
    const wrong = await fetch(`${harness.base}/admin/api/summary`, { headers: { Authorization: basic('admin', 'guess') } })
    expect(wrong.status).toBe(401)
    expect((await fetch(`${harness.base}/admin/`, { headers: { Authorization: basic('admin', 'guess-2') } })).status).toBe(401)
    expect((await fetch(`${harness.base}/admin/`, { headers: { Authorization: basic('admin', 'guess-3') } })).status).toBe(429)
    expect((await summary(harness)).todayActive).toBe(0)
  })

  it('keeps request content, identifiers, credentials and addresses out of logs', async () => {
    setBeijing('2026-10-31')
    const path = tempDatabase()
    const logs: string[] = []
    const harness = await start(path, { logs })
    const a = await register(harness)
    const marker = 'SENSITIVE-MARKER-7f3a'
    await report(harness, a)
    await post(harness, ANALYTICS_PATHS.activity, { protocol: 1, ...a, version: marker, platform: 'windows' }, { 'User-Agent': marker })
    await post(harness, ANALYTICS_PATHS.activity, `{"protocol":1,"note":"${marker}"`)
    await fetch(`${harness.base}/admin/api/summary`, { headers: { Authorization: basic('admin', marker) } })
    const control = new DatabaseSync(path)
    control.exec(`CREATE TRIGGER interrupt BEFORE DELETE ON instances BEGIN SELECT RAISE(ABORT, '${marker} ' || old.id); END`)
    await remove(harness, a)
    control.close()
    setBeijing('2026-12-31')
    await summary(harness)

    expect(logs.some((line) => line.includes('"event":"failure"'))).toBe(true)
    expect(logs.some((line) => line.includes('"event":"retention_applied"'))).toBe(true)
    const text = logs.join('\n')
    for (const secret of [marker, a.instanceId, a.token, '127.0.0.1']) expect(text).not.toContain(secret)
  })
})
