import Database from 'better-sqlite3'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ANALYTICS_PACING, beijingDay, createAnalyticsService } from '../src/main/analytics/service'
import { createAnalyticsTransport, type AnalyticsTransport } from '../src/main/analytics/transport'
import type { SecretProtector } from '../src/main/identity/protection'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { asStore } from './helpers/store'

const folders: string[] = []
const databases: ReadingDatabase[] = []
const servers: Server[] = []
const processes: ChildProcess[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const child of processes.splice(0)) child.kill('SIGKILL')
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    server.closeAllConnections()
    return promise
  }))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function databasePath(): string {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-analytics-client-'))
  folders.push(folder)
  return join(folder, 'reading.sqlite')
}

function open(path: string): ReadingDatabase {
  const db = openReadingDatabase(path)
  databases.push(db)
  return db
}

function reopen(db: ReadingDatabase, path: string): ReadingDatabase {
  db.close()
  databases.splice(databases.indexOf(db), 1)
  return open(path)
}

/** Stands in for OS secret storage (none on the test host): reversible, never the plain text. */
function protector(): SecretProtector & { available: boolean } {
  const fake = {
    available: true,
    async isAvailable() { return fake.available },
    async encrypt(secret: string) {
      if (!fake.available) throw new Error('unavailable')
      return new Uint8Array(Buffer.from(`sealed:${[...secret].reverse().join('')}`))
    },
    async decrypt(ciphertext: Uint8Array) {
      if (!fake.available) throw new Error('unavailable')
      return [...Buffer.from(ciphertext).toString().slice('sealed:'.length)].reverse().join('')
    }
  }
  return fake
}

/** Denies writes of the statistics record only, like a full disk would, through real SQLite. */
function denyAnalyticsWrites(path: string, deny: boolean): void {
  const raw = new Database(path)
  if (deny) {
    raw.exec(`
      CREATE TRIGGER deny_analytics_insert BEFORE INSERT ON settings WHEN NEW.key = 'analytics' BEGIN SELECT RAISE(ABORT, 'denied'); END;
      CREATE TRIGGER deny_analytics_update BEFORE UPDATE ON settings WHEN NEW.key = 'analytics' BEGIN SELECT RAISE(ABORT, 'denied'); END;
    `)
  } else {
    raw.exec('DROP TRIGGER deny_analytics_insert; DROP TRIGGER deny_analytics_update;')
  }
  raw.close()
}

interface Received { path: string; body: Record<string, unknown>; url: string; headers: IncomingMessage['headers'] }
type Reply = (request: Received, response: ServerResponse) => void | Promise<void>

/** A controlled receiving service: records each request and answers as the protocol does, or as told. */
async function receiver(clock: { wall: number }) {
  const requests: Received[] = []
  const tokens = new Map<string, string>()
  const deleted = new Set<string>()
  let serial = 0
  const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    response.end(JSON.stringify(value))
  }
  const protocol: Reply = (request, response) => {
    const { instanceId, token } = request.body
    if (request.path === '/v1/instances') {
      serial++
      const id = `instance${String(serial).padStart(14, '0')}`
      const secret = `token${String(serial).padStart(38, '0')}`
      tokens.set(id, secret)
      json(response, 201, { instanceId: id, token: secret })
    } else if (request.path === '/v1/activity') {
      if (typeof instanceId !== 'string' || tokens.get(instanceId) !== token || deleted.has(instanceId)) json(response, 403, { error: 'invalid_credentials' })
      else json(response, 200, { statDay: beijingDay(clock.wall), duplicate: false })
    } else {
      if (typeof instanceId === 'string' && tokens.get(instanceId) === token) deleted.add(instanceId)
      json(response, 200, { deleted: true })
    }
  }
  const state = { reply: protocol, requests, tokens, deleted, json, protocol }
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const request: Received = {
        path: new URL(incoming.url ?? '/', 'http://x').pathname,
        url: incoming.url ?? '',
        headers: incoming.headers,
        body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
      }
      requests.push(request)
      void state.reply(request, response)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { ...state, origin, set(reply: Reply) { state.reply = reply } }
}

/** Beijing wall time `day time`, a monotonic clock, captured timers and a foreground switch. */
function harness(origin: string, start = '2026-10-31T12:00:00+08:00') {
  const clock = { wall: Date.parse(start), mono: 1_000_000, foreground: true }
  let timer: { callback: () => void; at: number } | null = null
  const lock = protector()
  const real = createAnalyticsTransport({ origin, timeoutMs: 60_000, userAgent: 'Xidao/1.2.3' })
  const inFlight = new Set<Promise<unknown>>()
  const transport: AnalyticsTransport = {
    post(path, body, signal) {
      const request = real.post(path, body, signal)
      inFlight.add(request)
      void request.catch(() => undefined).finally(() => inFlight.delete(request))
      return request
    }
  }
  const create = (db: ReadingDatabase) => createAnalyticsService({
    store: asStore(db),
    storageReady: () => true,
    protector: lock,
    transport,
    receiver: '127.0.0.1',
    platform: 'windows',
    version: '1.2.3',
    isForeground: () => clock.foreground,
    now: () => clock.wall,
    monotonic: () => clock.mono,
    schedule: (callback, ms) => {
      const entry = { callback, at: clock.mono + ms }
      timer = entry
      return () => { if (timer === entry) timer = null }
    }
  })
  /** Moves both clocks on and runs the pending timer when it is due. */
  const advance = (ms: number) => {
    clock.wall += ms
    clock.mono += ms
    const due = timer
    if (due !== null && due.at <= clock.mono) {
      timer = null
      due.callback()
    }
  }
  /**
   * Waits until the service is quiet: every request it sent has its answer, and the local work
   * that follows (protection, storage, the next request it starts) has run.
   */
  const settle = async () => {
    for (let turn = 0; turn < 50; turn++) {
      if (inFlight.size > 0) await Promise.allSettled([...inFlight])
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return { clock, lock, create, advance, settle }
}

/** Event-loop turns (no wall-clock wait) until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000 && !condition(); turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(condition()).toBe(true)
}

function storedJson(path: string): string {
  const raw = new Database(path, { readonly: true })
  const row = raw.prepare<[], { value_json: string }>("SELECT value_json FROM settings WHERE key = 'analytics'").get()
  raw.close()
  return row?.value_json ?? ''
}

describe('desktop usage statistics', () => {
  it('starts unanswered and off on an upgraded database, sends nothing before consent, and keeps an off answer across reopen', async () => {
    const path = databasePath()
    let db = open(path)
    db.saveSettings({ ...DEFAULT_SETTINGS, newTabSplitDefault: false })
    const service = await receiver({ wall: Date.now() })
    const { create, settle } = harness(service.origin)
    const first = create(db)
    expect(await first.getState()).toMatchObject({ availability: 'available', choice: 'unset', saved: 'unset', hasIdentity: false })
    for (let i = 0; i < 10; i++) first.poke()
    await settle()
    expect(service.requests).toHaveLength(0)
    expect(await first.setChoice('off')).toMatchObject({ result: 'saved', state: { choice: 'off', saved: 'off' } })
    db = reopen(db, path)
    const second = create(db)
    expect(await second.getState()).toMatchObject({ choice: 'off', saved: 'off', hasIdentity: false })
    second.poke()
    await settle()
    expect(service.requests).toHaveLength(0)
    expect(db.loadSettings().newTabSplitDefault).toBe(false)
  })

  it('stores protected credentials before the first report, reports once per statistics day across restarts, and again after Beijing midnight in the foreground', async () => {
    const path = databasePath()
    let db = open(path)
    const clockRef = { wall: 0 }
    const service = await receiver(clockRef)
    const { clock, create, advance, settle } = harness(service.origin, '2026-10-31T23:58:00+08:00')
    Object.defineProperty(clockRef, 'wall', { get: () => clock.wall })
    const first = create(db)
    expect(await first.setChoice('on')).toMatchObject({ result: 'saved', state: { choice: 'on', saved: 'on' } })
    await settle()
    expect(service.requests.map((request) => request.path)).toEqual(['/v1/instances', '/v1/activity'])
    const [register, activity] = service.requests
    expect(register!.body).toEqual({ protocol: 1 })
    expect(Object.keys(activity!.body).sort()).toEqual(['instanceId', 'platform', 'protocol', 'token', 'version'])
    expect(activity!.body).toMatchObject({ protocol: 1, version: '1.2.3', platform: 'windows' })
    expect(activity!.url).toBe('/v1/activity')
    expect(activity!.headers.cookie).toBeUndefined()
    const token = activity!.body.token as string
    expect(storedJson(path)).not.toContain(token)
    expect(db.loadAnalytics()).toMatchObject({ choice: 'on', reportedDay: '2026-10-31', deletionPending: false })

    // A focus storm and a restart on the same statistics day send nothing more.
    for (let i = 0; i < 20; i++) first.poke()
    await first.stop()
    db = reopen(db, path)
    const second = create(db)
    await second.start()
    for (let i = 0; i < 20; i++) second.poke()
    await settle()
    expect(service.requests).toHaveLength(2)

    // Still in the foreground across midnight: the day-boundary timer reports the new day once.
    advance(90_000)
    advance(60_000)
    await settle()
    expect(service.requests.map((request) => request.path)).toEqual(['/v1/instances', '/v1/activity', '/v1/activity'])
    expect(service.requests[2]!.body.token).toBe(token)
    await second.stop()

    // Next day in the background (hidden, minimized or locked) counts nothing until foreground use.
    db = reopen(db, path)
    clock.foreground = false
    advance(24 * 60 * 60_000)
    const third = create(db)
    await third.start()
    third.poke()
    advance(ANALYTICS_PACING.recheckMs)
    await settle()
    expect(service.requests).toHaveLength(3)
    clock.foreground = true
    third.poke()
    await settle()
    expect(service.requests).toHaveLength(4)
    expect(db.loadAnalytics()).toMatchObject({ reportedDay: '2026-11-02' })
  })

  it('keeps statistics off when saving the choice fails, and stops this run at once when saving off fails', async () => {
    const path = databasePath()
    const db = open(path)
    const service = await receiver({ wall: Date.parse('2026-10-31T12:00:00+08:00') })
    const { create, lock, settle } = harness(service.origin)
    const current = create(db)
    denyAnalyticsWrites(path, true)
    expect(await current.setChoice('on')).toMatchObject({ result: 'not-saved', state: { choice: 'unset', saved: 'unset' } })
    current.poke()
    await settle()
    expect(service.requests).toHaveLength(0)

    denyAnalyticsWrites(path, false)
    lock.available = false
    expect(await current.setChoice('on')).toMatchObject({ result: 'refused', reason: 'protection-unavailable', state: { choice: 'unset' } })
    lock.available = true
    expect(await current.setChoice('on')).toMatchObject({ result: 'saved' })
    await settle()
    expect(service.requests).toHaveLength(2)

    denyAnalyticsWrites(path, true)
    expect(await current.setChoice('off')).toMatchObject({ result: 'not-saved', state: { choice: 'off', saved: 'on' } })
    current.poke()
    await settle()
    expect(service.requests).toHaveLength(2)
    denyAnalyticsWrites(path, false)
    // The next start follows what is really stored.
    expect(await create(db).getState()).toMatchObject({ choice: 'on', saved: 'on' })
  })

  it('turning off aborts the request in flight; its late answer neither records the day nor restarts reporting', async () => {
    const path = databasePath()
    const db = open(path)
    const wall = { wall: Date.parse('2026-10-31T12:00:00+08:00') }
    const service = await receiver(wall)
    const { create, advance, settle } = harness(service.origin)
    const held: Array<() => void> = []
    let aborted = 0
    service.set((request, response) => {
      if (request.path !== '/v1/activity') return service.protocol(request, response)
      response.on('close', () => { if (!response.writableEnded) aborted++ })
      held.push(() => { if (!response.destroyed) service.protocol(request, response) })
    })
    const current = create(db)
    await current.setChoice('on')
    await until(() => held.length === 1)
    expect(await current.setChoice('off')).toMatchObject({ result: 'saved', state: { choice: 'off' } })
    // Aborted by turning off, long before the transport's own timeout.
    await until(() => aborted === 1)
    await settle()
    held[0]!()
    for (let i = 0; i < 5; i++) {
      current.poke()
      advance(ANALYTICS_PACING.recheckMs)
    }
    await settle()
    expect(service.requests.map((request) => request.path)).toEqual(['/v1/instances', '/v1/activity'])
    expect(db.loadAnalytics()).toMatchObject({ choice: 'off', reportedDay: null })
  })

  it('backs off after failures, honours Retry-After, never exceeds the daily request budget, and drops an identity the service no longer knows only while on', async () => {
    const path = databasePath()
    const db = open(path)
    const service = await receiver({ wall: Date.parse('2026-10-31T09:00:00+08:00') })
    const { create, advance, settle } = harness(service.origin, '2026-10-31T09:00:00+08:00')
    service.set((request, response) => {
      if (request.path === '/v1/instances') return service.protocol(request, response)
      service.json(response, 500, { error: 'server_error' })
    })
    const current = create(db)
    await current.setChoice('on')
    await settle()
    expect(service.requests).toHaveLength(2)
    // Focus storm right after a failure: nothing until the back-off passed.
    for (let i = 0; i < 30; i++) current.poke()
    advance(ANALYTICS_PACING.backoffMs[0] - 1_000)
    await settle()
    expect(service.requests).toHaveLength(2)
    advance(2_000)
    await settle()
    expect(service.requests).toHaveLength(3)

    service.set((_request, response) => service.json(response, 429, { error: 'rate_limited' }, { 'Retry-After': '3600' }))
    advance(ANALYTICS_PACING.backoffMs[1])
    await settle()
    expect(service.requests).toHaveLength(4)
    advance(3_000_000)
    current.poke()
    await settle()
    expect(service.requests).toHaveLength(4)

    // Hours of failures within one day stay within the budget.
    service.set((_request, response) => service.json(response, 502, {}))
    for (let i = 0; i < 40; i++) {
      advance(ANALYTICS_PACING.recheckMs)
      current.poke()
      await settle()
    }
    expect(service.requests.length).toBeLessThanOrEqual(ANALYTICS_PACING.requestsPerDay)

    // Next day the service forgot the identity: the client registers a new one, still on.
    service.set(service.protocol)
    const before = db.loadAnalytics().identity
    service.deleted.add(before!.instanceId)
    advance(24 * 60 * 60_000)
    current.poke()
    await settle()
    advance(ANALYTICS_PACING.minSpacingMs)
    await settle()
    const paths = service.requests.slice(-3).map((request) => request.path)
    expect(paths).toEqual(['/v1/activity', '/v1/instances', '/v1/activity'])
    expect(db.loadAnalytics().identity!.instanceId).not.toBe(before!.instanceId)
  })

  it('a registration answered after the window left the foreground stores the identity but reports only at the next foreground moment', async () => {
    const path = databasePath()
    const db = open(path)
    const service = await receiver({ wall: Date.parse('2026-10-31T12:00:00+08:00') })
    const { clock, create, advance, settle } = harness(service.origin)
    const held: Array<() => void> = []
    service.set((request, response) => {
      if (request.path === '/v1/instances') held.push(() => service.protocol(request, response))
      else service.protocol(request, response)
    })
    const current = create(db)
    await current.setChoice('on')
    await until(() => held.length === 1)
    clock.foreground = false
    held[0]!()
    await settle()
    expect(service.requests.map((request) => request.path)).toEqual(['/v1/instances'])
    expect(db.loadAnalytics().identity).not.toBeNull()
    clock.foreground = true
    advance(ANALYTICS_PACING.minSpacingMs)
    current.poke()
    await settle()
    expect(service.requests.map((request) => request.path)).toEqual(['/v1/instances', '/v1/activity'])
  })

  it('a registration that succeeds with the last request of the day keeps its identity without exceeding the daily budget', async () => {
    const path = databasePath()
    const db = open(path)
    const wall = { wall: 0 }
    const service = await receiver(wall)
    const { clock, create, advance, settle } = harness(service.origin, '2026-10-31T08:00:00+08:00')
    Object.defineProperty(wall, 'wall', { get: () => clock.wall })
    let failing = ANALYTICS_PACING.requestsPerDay - 1
    service.set((request, response) => {
      if (request.path === '/v1/instances' && failing > 0) {
        failing--
        service.json(response, 500, { error: 'server_error' })
      } else service.protocol(request, response)
    })
    const current = create(db)
    await current.setChoice('on')
    await settle()
    for (let i = 0; i < 48; i++) {
      advance(ANALYTICS_PACING.recheckMs)
      current.poke()
      await settle()
    }
    expect(beijingDay(clock.wall)).toBe('2026-10-31')
    expect(service.requests).toHaveLength(ANALYTICS_PACING.requestsPerDay)
    expect(service.requests.every((request) => request.path === '/v1/instances')).toBe(true)
    expect(db.loadAnalytics().identity).not.toBeNull()
    // The next statistics day reports with the kept identity, without registering again.
    advance(24 * 60 * 60_000)
    current.poke()
    await settle()
    expect(service.requests.slice(ANALYTICS_PACING.requestsPerDay).map((request) => request.path)).toEqual(['/v1/activity'])
  })

  it('a deletion whose intent could not be stored stays unresolved for this run: turning on is refused until a deletion succeeds', async () => {
    const path = databasePath()
    const db = open(path)
    const service = await receiver({ wall: Date.parse('2026-10-31T12:00:00+08:00') })
    const { create, settle } = harness(service.origin)
    const current = create(db)
    await current.setChoice('on')
    await settle()
    denyAnalyticsWrites(path, true)
    expect(await current.deleteData()).toMatchObject({ result: 'failed', reason: 'storage', state: { choice: 'off', deletionPending: true, hasIdentity: true } })
    expect(service.requests.filter((request) => request.path === '/v1/deletion')).toHaveLength(0)
    denyAnalyticsWrites(path, false)
    expect(await current.setChoice('on')).toMatchObject({ result: 'refused', reason: 'deletion-pending' })
    current.poke()
    await settle()
    expect(service.requests).toHaveLength(2)
    expect(await current.deleteData()).toMatchObject({ result: 'deleted', state: { deletionPending: false, hasIdentity: false } })
    expect(await current.setChoice('on')).toMatchObject({ result: 'saved' })
  })

  it('deletion stops first, keeps the credentials while the service cannot confirm, blocks a new identity, and clears them once confirmed', async () => {
    const path = databasePath()
    let db = open(path)
    const service = await receiver({ wall: Date.parse('2026-10-31T12:00:00+08:00') })
    const { create, advance, settle } = harness(service.origin)
    let current = create(db)
    await current.setChoice('on')
    await settle()
    const identity = db.loadAnalytics().identity!
    service.set((request, response) => {
      if (request.path === '/v1/deletion') service.json(response, 503, { error: 'server_error' })
      else service.protocol(request, response)
    })
    expect(await current.deleteData()).toMatchObject({ result: 'failed', reason: 'service', state: { choice: 'off', deletionPending: true, hasIdentity: true } })
    expect(await current.setChoice('on')).toMatchObject({ result: 'refused', reason: 'deletion-pending' })
    advance(24 * 60 * 60_000)
    current.poke()
    await settle()
    expect(service.requests.filter((request) => request.path !== '/v1/deletion')).toHaveLength(2)

    // Across a restart: still pending, still off, credentials kept.
    db = reopen(db, path)
    current = create(db)
    expect(await current.getState()).toMatchObject({ choice: 'off', saved: 'off', deletionPending: true, hasIdentity: true })
    service.set(service.protocol)
    // Two presses join one deletion.
    const [one, two] = await Promise.all([current.deleteData(), current.deleteData()])
    expect(one).toMatchObject({ result: 'deleted', state: { deletionPending: false, hasIdentity: false, choice: 'off' } })
    expect(two).toBe(one)
    expect(service.deleted.has(identity.instanceId)).toBe(true)
    expect(service.requests.filter((request) => request.path === '/v1/deletion')).toHaveLength(2)
    expect(db.loadAnalytics()).toEqual({ choice: 'off', identity: null, deletionPending: false, reportedDay: null })

    // Repeating it asks nothing (no identity left); turning on again starts a new identity.
    expect(await current.deleteData()).toMatchObject({ result: 'deleted' })
    expect(service.requests.filter((request) => request.path === '/v1/deletion')).toHaveLength(2)
    await current.setChoice('on')
    await settle()
    expect(db.loadAnalytics().identity!.instanceId).not.toBe(identity.instanceId)
  })

  it('reports through the real statistics service and deletes there: dashboard counts follow, old credentials are refused', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'xidao-analytics-e2e-'))
    folders.push(folder)
    const password = 'isolated-acceptance-password'
    const hash = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/analytics/main.ts', 'hash-password'], {
      input: password, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8'
    }).stdout.trim()
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    // The service's wall clock starts at Beijing noon of a fixed day (its own clock seam is
    // `Date.now`), so the statistics day never depends on when the suite runs.
    const noon = '2026-10-31T12:00:00+08:00'
    const clockShift = `data:text/javascript,const o=${Date.parse(noon)}-Date.now();const n=Date.now;Date.now=()=>n()+o`
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${clockShift}`, 'server/analytics/main.ts', 'serve'], {
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1',
        XIDAO_ANALYTICS_DB: join(folder, 'analytics.sqlite'),
        XIDAO_ANALYTICS_ADMIN_PASSWORD_HASH: hash,
        XIDAO_ANALYTICS_PORT: String(port)
      },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    processes.push(child)
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('"listening"')) resolve() })
      child.once('exit', () => reject(new Error('service exited')))
    })
    const origin = `http://127.0.0.1:${port}`
    const summary = async () => {
      const response = await fetch(`${origin}/admin/api/summary`, {
        headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` }
      })
      return await response.json() as { todayActive: number; window: { active: number }; distributions: { today: { versions: unknown[]; platforms: unknown[] } } }
    }
    expect((await summary()).todayActive).toBe(0)

    const path = databasePath()
    const db = open(path)
    const { create, settle } = harness(origin, noon)
    const current = create(db)
    await current.setChoice('on')
    await settle()
    expect(db.loadAnalytics().reportedDay).toBe('2026-10-31')
    const counted = await summary()
    expect(counted.todayActive).toBe(1)
    expect(counted.window.active).toBe(1)
    expect(counted.distributions.today.versions).toEqual([{ value: '1.2.3', count: 1 }])
    expect(counted.distributions.today.platforms).toEqual([{ value: 'windows', count: 1 }])

    const identity = db.loadAnalytics().identity!
    const lock = protector()
    const token = await lock.decrypt(Buffer.from(identity.protectedToken, 'base64'))
    expect(await current.deleteData()).toMatchObject({ result: 'deleted', state: { hasIdentity: false } })
    expect((await summary()).todayActive).toBe(0)
    const late = await fetch(`${origin}/v1/activity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: 1, instanceId: identity.instanceId, token, version: '1.2.3', platform: 'windows' })
    })
    expect(late.status).toBe(403)
  })
})
